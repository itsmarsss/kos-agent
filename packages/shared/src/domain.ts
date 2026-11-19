/**
 * The registrable domain of a host: the part one owner holds, which is
 * what says whose site it is ("example.co.uk" of "login.example.co.uk",
 * "alice.github.io" of "www.alice.github.io"). Read against a small
 * vendored part of the Public Suffix List (publicsuffix.org): the
 * multi-label suffixes people meet most, country second levels and the
 * hosting domains whose subdomains belong to different people. A suffix
 * it does not know is taken as one label, which can show a domain one
 * label too short, never one label too long.
 */
const SUFFIXES = new Set([
  // Country second levels.
  ...["co", "org", "ac", "gov", "ltd", "plc", "me", "net", "sch", "nhs", "police"].map((l) => `${l}.uk`),
  ...["com", "net", "org", "edu", "gov", "asn", "id"].map((l) => `${l}.au`),
  ...["co", "org", "net", "ac", "govt", "school", "geek", "kiwi"].map((l) => `${l}.nz`),
  ...["co", "ne", "or", "ac", "go", "ed", "gr", "lg"].map((l) => `${l}.jp`),
  ...["co", "or", "ne", "ac", "go", "re"].map((l) => `${l}.kr`),
  ...["com", "net", "org", "gov", "edu", "art", "blog", "eco", "tec"].map((l) => `${l}.br`),
  ...["com", "net", "org", "gov", "edu", "ac"].map((l) => `${l}.cn`),
  ...["com", "net", "org", "gov", "edu", "idv"].map((l) => `${l}.tw`),
  ...["com", "net", "org", "gov", "edu", "idv"].map((l) => `${l}.hk`),
  ...["com", "net", "org", "gov", "edu", "per"].map((l) => `${l}.sg`),
  ...["co", "net", "org", "gen", "firm", "ind", "ac", "gov", "edu", "res"].map((l) => `${l}.in`),
  ...["co", "org", "net", "gov", "ac", "web"].map((l) => `${l}.za`),
  ...["com", "net", "org", "gob", "edu"].map((l) => `${l}.mx`),
  ...["com", "net", "org", "gob", "edu", "int"].map((l) => `${l}.ar`),
  ...["com", "net", "org", "gov", "edu", "bel", "gen", "web"].map((l) => `${l}.tr`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.my`),
  ...["co", "or", "ac", "go", "web", "my", "biz"].map((l) => `${l}.id`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.ph`),
  ...["co", "or", "ac", "go", "in"].map((l) => `${l}.th`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.vn`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.pk`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.eg`),
  ...["com", "net", "org", "gov", "edu", "co"].map((l) => `${l}.il`),
  ...["com", "net", "org", "gov", "edu", "sch"].map((l) => `${l}.sa`),
  ...["co", "ac", "gov", "org", "net"].map((l) => `${l}.ke`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.ng`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.ua`),
  ...["com", "net", "org", "pp", "msk", "spb"].map((l) => `${l}.ru`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.pl`),
  ...["co", "com", "net", "org"].map((l) => `${l}.at`),
  ...["com", "net", "org", "gov", "edu"].map((l) => `${l}.co`),
  // Hosts that hand out subdomains to different people.
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app", "herokuapp.com", "web.app", "firebaseapp.com",
  "appspot.com", "blogspot.com", "azurewebsites.net", "cloudfront.net", "s3.amazonaws.com", "fly.dev", "onrender.com", "glitch.me",
  "repl.co", "ngrok.io", "ngrok-free.app", "trycloudflare.com", "myshopify.com", "wixsite.com", "squarespace.com", "webflow.io",
  "translate.goog", "sharepoint.com", "readthedocs.io", "surge.sh", "deno.dev", "codesandbox.io", "stackblitz.io",
]);

/** The registrable domain of `host`; an address or a single-label host is itself. */
export function registrableDomain(host: string): string {
  const name = host.toLowerCase().replace(/\.$/, "");
  if (/^[\d.]+$/.test(name) || name.includes(":") || !name.includes(".")) return name;
  const labels = name.split(".");
  for (let i = 0; i < labels.length - 1; i++) {
    if (SUFFIXES.has(labels.slice(i + 1).join("."))) return labels.slice(i).join(".");
  }
  return labels.slice(-2).join(".");
}
