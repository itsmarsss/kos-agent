/** The part of libheif-js's WebAssembly build KOS uses: decoding a HEIC or HEIF to RGBA. */
declare module "libheif-js/wasm-bundle.js" {
  interface HeifPixels {
    data: Uint8ClampedArray;
    width: number;
    height: number;
  }
  interface HeifImage {
    get_width(): number;
    get_height(): number;
    /** Fills `into` with the picture as RGBA and hands it back, or null when it cannot. */
    display(into: HeifPixels, done: (out: HeifPixels | null) => void): void;
    free(): void;
  }
  const libheif: {
    HeifDecoder: new () => { decode(bytes: Uint8Array): HeifImage[] };
  };
  export default libheif;
}
