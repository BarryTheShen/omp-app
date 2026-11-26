/** A data file bundled with the server (`import path from "./x.bin" with { type: "file" }`): its path, for `Bun.file`. */
declare module "*.bin" {
  const path: string;
  export default path;
}
