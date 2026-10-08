import type { RealToolResult } from "../../U3/tool-card/real-result";

/** A real `glob` result that stopped at its result limit; omp reports the count it reached as a number. */
export const T2_GLOB_LIMIT_RESULTS: readonly RealToolResult[] = [
  {
    name: "glob: the result limit was reached",
    toolName: "glob",
    args: { path: "~/.omp/**/*.yml; ~/.omp/**/*.json", gitignore: false },
    result: {
      content: [
        {
          type: "text",
          text: "# /home/user/.omp/\n## agent/\nconfig.yml\n### cache/\n#### composer/0000/\nstatus.json",
        },
      ],
      details: {
        scopePath: "/home/user/.omp/**/*.yml, /home/user/.omp/**/*.json",
        fileCount: 200,
        files: [
          "/home/user/.omp/agent/cache/composer/0000/status.json",
          "/home/user/.omp/agent/config.yml",
        ],
        truncated: true,
        resultLimitReached: 200,
        cwd: "/home/user",
        meta: { limits: { resultLimit: { reached: 200, suggestion: 400 } } },
      },
    },
    isError: false,
    shows: ["200 matches"],
  },
];
