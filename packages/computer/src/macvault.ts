import { openFromDevice, p256Pair, P256_POINT_BYTES, VaultError, type DeviceUnwrapper, type Vault, type VaultDevices } from "@kos/harness";

import type { DeviceHub } from "./hub.js";

/**
 * The owner's vault opened at login by the KOS for Mac on this computer
 * (docs/secrets.md, Device slots; docs/computer.md, The vault).
 *
 * The Mac keeps a P-256 key in its Secure Enclave; a device slot holds the
 * vault's data key sealed to its point. To open one, the host makes an
 * ephemeral key pair and sends its point with the slot's (`vault.unwrap`);
 * the Mac does the ECDH in the Secure Enclave and answers the slot's key
 * sealed to the host's ephemeral point, so even on loopback no key crosses
 * in the clear. Only a Mac proved to run here is asked.
 */

const VAULT_CALL_MS = 15_000;

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export class MacVault implements VaultDevices {
  constructor(private readonly hub: () => DeviceHub | undefined) {}

  here(): { id: string; name: string } | { reason: string } {
    const hub = this.hub();
    if (!hub) return { reason: "computer use is off, so no Mac can open the vault" };
    const [mac] = hub.macsHere();
    return mac ? { id: mac.id, name: mac.name } : { reason: "KOS for Mac is not running on this computer, or is not connected to KOS" };
  }

  async key(device: string): Promise<Buffer> {
    const hub = this.hub();
    if (!hub) throw new VaultError("refused", "computer use is off, so no Mac can open the vault");
    let answer: Record<string, unknown>;
    try {
      answer = await hub.vaultCall(device, "vault.key", {}, VAULT_CALL_MS);
    } catch (err) {
      throw new VaultError("refused", `KOS for Mac gave no vault key: ${words(err)}`);
    }
    const key = typeof answer.key === "string" ? Buffer.from(answer.key, "base64") : Buffer.alloc(0);
    if (key.length !== P256_POINT_BYTES || key[0] !== 0x04) throw new VaultError("refused", "KOS for Mac answered with a key that is not a P-256 point; update it");
    return key;
  }

  unwrapper(device: string): DeviceUnwrapper {
    return async (req) => {
      const hub = this.hub();
      if (!hub) throw new VaultError("refused", "computer use is off, so no Mac can open the vault");
      const host = p256Pair();
      try {
        let answer: Record<string, unknown>;
        try {
          answer = await hub.vaultCall(device, "vault.unwrap", { ...req, hostEpk: host.pub.toString("base64") }, VAULT_CALL_MS);
        } catch (err) {
          throw new VaultError("refused", words(err));
        }
        const { epk, nonce, ct } = answer;
        if (typeof epk !== "string" || typeof nonce !== "string" || typeof ct !== "string") throw new VaultError("refused", "KOS for Mac's answer is not a sealed key; update it");
        try {
          return openFromDevice(host, { epk, nonce, ct }, req.vault, req.slot);
        } catch {
          throw new VaultError("refused", "KOS for Mac's answer does not open: it was not sealed to this request");
        }
      } finally {
        host.priv.fill(0);
      }
    };
  }

  /** Every Mac here asked in turn, until one answers. */
  anyHere(): DeviceUnwrapper {
    return async (req) => {
      const macs = this.hub()?.macsHere() ?? [];
      if (!macs.length) throw new VaultError("refused", "KOS for Mac is not connected on this computer");
      const why: string[] = [];
      for (const mac of macs) {
        try {
          return await this.unwrapper(mac.id)(req);
        } catch (err) {
          why.push(words(err));
        }
      }
      throw new VaultError("refused", why.join("; "));
    };
  }
}

/**
 * A locked vault with a device slot is opened by the Mac here as soon as it
 * can be: when a Mac proves it is here, and when the vault changes while
 * locked (another process sealed the slot afresh). One ask at a time; a
 * failure leaves the vault locked with the reason in its status.
 */
export function unlockAtLogin(deps: { vault: Vault; hub: DeviceHub; macs: MacVault; log: (line: string) => void }): () => void {
  const { vault, hub, macs, log } = deps;
  let asking = false;
  let again = false;
  const attempt = async (): Promise<void> => {
    const status = vault.status();
    if (status.state !== "locked" || !status.devices?.length || !hub.macsHere().length) return;
    if (asking) {
      again = true;
      return;
    }
    asking = true;
    try {
      const opened = await vault.unlockWithDevice(macs.anyHere());
      log(opened ? "secrets: KOS for Mac opened the vault" : `secrets: ${vault.status().problem ?? "KOS for Mac did not open the vault"}`);
    } catch (err) {
      log(`secrets: KOS for Mac did not open the vault: ${words(err)}`);
    } finally {
      asking = false;
      if (again) {
        again = false;
        void attempt();
      }
    }
  };
  const offs = [hub.onConnected(() => void attempt()), vault.onChange(() => void attempt())];
  void attempt();
  return () => offs.forEach((off) => off());
}
