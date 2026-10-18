import type { RealToolResult } from "../../U3/tool-card/real-result";

/** Real browser results from older omp sessions (2026-08-20/29); retained as historical recordings, not v18.9.1 fixtures. */
export const T4_BROWSER_RESULTS: readonly RealToolResult[] = [
  {
    name: "browser: a page closed, nothing to close",
    toolName: "browser",
    args: { action: "close", all: "true" },
    result: {
      content: [{ type: "text", text: "Released 0 managed tabs" }],
      details: { action: "close", name: "main", result: "Released 0 managed tabs" },
    },
    isError: false,
    shows: ["Released 0 managed tabs"],
  },
  {
    name: "browser: a script's value, returned as JSON",
    toolName: "browser",
    args: {
      action: "run",
      code: "await new Promise(r => setTimeout(r, 2500));\nreturn await tab.evaluate(() => ({ next: [...document.querySelectorAll('a')] }));",
    },
    result: {
      content: [
        {
          type: "text",
          text: '{\n  "next": [\n    {\n      "disabled": false,\n      "text": "Next lesson"\n    }\n  ],\n  "progress": [\n    {\n      "label": "Course progress: 9%",\n      "value": "9"\n    }\n  ]\n}',
        },
      ],
      details: {
        action: "run",
        name: "course",
        browser: "relay",
        url: "https://example.edu/course/1/page/2",
        result:
          '{\n  "next": [\n    {\n      "disabled": false,\n      "text": "Next lesson"\n    }\n  ],\n  "progress": [\n    {\n      "label": "Course progress: 9%",\n      "value": "9"\n    }\n  ]\n}',
      },
    },
    isError: false,
    shows: ["Next lesson", "Course progress: 9%"],
  },
  {
    name: "browser: a page that timed out opening",
    toolName: "browser",
    args: { action: "open", url: "file:///tmp/chart_test.html", name: "charts" },
    result: {
      content: [{ type: "text", text: "Browser open timed out after 30000ms" }],
      details: {},
    },
    isError: true,
    shows: ["Browser open timed out after 30000ms"],
  },
];
