/** Bun's text imports (`with { type: "text" }`): omp's prompt files, read as strings and built into the program. */
declare module "*.md" {
  const text: string;
  export default text;
}
