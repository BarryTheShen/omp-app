import type { TextMessagePartProps } from "@assistant-ui/react";
import {
  MarkdownTextPrimitive,
  unstable_memoizeMarkdownComponents as memoizeMarkdownComponents,
  useIsMarkdownCodeBlock,
} from "@assistant-ui/react-markdown";
import { CheckIcon, CopyIcon } from "lucide-react";
import { type FC, type HTMLAttributes, memo, type ReactNode, useState } from "react";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import { SafeImage } from "../media";

export type MarkdownTextProps = Partial<TextMessagePartProps> & {
  readonly variant?: "default" | "compact";
};

function CodeBlock({ className, children, ...props }: HTMLAttributes<HTMLElement>) {
  const isCodeBlock = useIsMarkdownCodeBlock();
  const [copied, setCopied] = useState(false);
  if (!isCodeBlock) {
    return (
      <code
        {...props}
        className={cn("bg-muted rounded-md px-1.5 py-0.5 font-mono text-[0.85em]", className)}
        data-markdown-inline
      >
        {children}
      </code>
    );
  }

  const language = /language-([\w-]+)/.exec(className ?? "")?.[1] ?? "text";
  const code = String(children).replace(/\n$/, "");
  const copy = async () => {
    if (typeof navigator === "undefined" || navigator.clipboard === undefined) return;
    await navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <div
      className="border-border bg-muted/30 my-3 overflow-hidden rounded-lg border"
      data-markdown-code
    >
      <div className="border-border/60 bg-muted/60 flex items-center justify-between border-b px-3 py-1.5 text-xs">
        <span className="text-muted-foreground font-mono" data-code-language>
          {language}
        </span>
        <button
          aria-label={copied ? "Copied code" : "Copy code"}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 rounded px-1.5 py-1 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          data-markdown-copy
          type="button"
          onClick={() => void copy()}
        >
          {copied ? (
            <CheckIcon aria-hidden="true" className="size-3.5" />
          ) : (
            <CopyIcon aria-hidden="true" className="size-3.5" />
          )}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre className="max-w-full overflow-x-auto p-3 text-sm leading-relaxed">
        <code {...props} className={cn("font-mono text-info", className)}>
          {children}
        </code>
      </pre>
    </div>
  );
}

function Link({
  href,
  children,
  ...props
}: {
  readonly href?: string;
  readonly children?: ReactNode;
}) {
  const safe = href?.startsWith("https://") === true || href?.startsWith("http://") === true;
  if (!safe) return <span {...props}>{children}</span>;
  return (
    <span className="inline">
      <a {...props} href={href} rel="noopener noreferrer" target="_blank">
        {children}
      </a>
      <span className="text-muted-foreground ms-1 text-xs" data-link-destination>
        ({href})
      </span>
    </span>
  );
}

const markdownComponents = memoizeMarkdownComponents({
  a: Link,
  blockquote: ({ children, ...props }: HTMLAttributes<HTMLQuoteElement>) => (
    <blockquote
      {...props}
      className="border-muted-foreground/30 text-muted-foreground my-3 border-s-2 ps-4 italic"
    >
      {children}
    </blockquote>
  ),
  code: CodeBlock,
  h1: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h1 {...props} className="mt-5 mb-2 text-2xl font-semibold tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props} className="mt-5 mb-2 text-xl font-semibold tracking-tight">
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h3 {...props} className="mt-4 mb-1 text-lg font-semibold">
      {children}
    </h3>
  ),
  img: SafeImage,
  li: ({ children, ...props }: HTMLAttributes<HTMLLIElement>) => <li {...props}>{children}</li>,
  ol: ({ children, ...props }: HTMLAttributes<HTMLOListElement>) => (
    <ol {...props} className="my-3 ms-5 list-decimal space-y-1">
      {children}
    </ol>
  ),
  p: ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props} className="my-3 leading-relaxed first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  table: ({ children, ...props }: HTMLAttributes<HTMLTableElement>) => (
    <div className="my-3 max-w-full overflow-x-auto" data-markdown-table>
      <table {...props} className="w-full min-w-max border-separate border-spacing-0 text-sm">
        {children}
      </table>
    </div>
  ),
  td: ({ children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
    <td {...props} className="border-border border px-3 py-1.5">
      {children}
    </td>
  ),
  th: ({ children, ...props }: HTMLAttributes<HTMLTableCellElement>) => (
    <th {...props} className="border-border bg-muted border px-3 py-1.5 text-start font-medium">
      {children}
    </th>
  ),
  ul: ({ children, ...props }: HTMLAttributes<HTMLUListElement>) => (
    <ul {...props} className="marker:text-muted-foreground my-3 ms-5 list-disc space-y-1">
      {children}
    </ul>
  ),
});
const compactMarkdownComponents = memoizeMarkdownComponents({
  ...markdownComponents,
  h1: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h1 {...props} className="mt-2 mb-1 text-base font-semibold tracking-tight">
      {children}
    </h1>
  ),
  h2: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h2 {...props} className="mt-2 mb-1 text-sm font-semibold tracking-tight">
      {children}
    </h2>
  ),
  h3: ({ children, ...props }: HTMLAttributes<HTMLHeadingElement>) => (
    <h3 {...props} className="mt-2 mb-1 text-sm font-semibold">
      {children}
    </h3>
  ),
  p: ({ children, ...props }: HTMLAttributes<HTMLParagraphElement>) => (
    <p {...props} className="my-1 leading-relaxed first:mt-0 last:mb-0">
      {children}
    </p>
  ),
  ol: ({ children, ...props }: HTMLAttributes<HTMLOListElement>) => (
    <ol {...props} className="my-1 ms-4 list-decimal space-y-0.5">
      {children}
    </ol>
  ),
  ul: ({ children, ...props }: HTMLAttributes<HTMLUListElement>) => (
    <ul {...props} className="marker:text-muted-foreground my-1 ms-4 list-disc space-y-0.5">
      {children}
    </ul>
  ),
});

/** U1.4's one Markdown implementation: assistant-ui's react-markdown primitive with safe components. */
export const MarkdownText: FC<MarkdownTextProps> = memo(({ variant = "default", ...props }) => (
  <MarkdownTextPrimitive
    {...props}
    components={variant === "compact" ? compactMarkdownComponents : markdownComponents}
    defer={false}
    remarkPlugins={[remarkGfm]}
    skipHtml
    smooth={false}
  />
));
