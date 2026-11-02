import type { SignInLink } from "@omp-app/contracts/chat-host";
import { Check, Copy, ExternalLink } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";

/**
 * A sign-in's page (#2784): opened in a browser tab, or copied, to be opened in any browser, on any device; wherever the
 * sign-in's question is answered, the chat or Settings. A copy that the browser refuses shows the address to copy by hand.
 */
export function SignInPage({
  link,
  instructions,
}: {
  readonly link: SignInLink;
  readonly instructions?: string | undefined;
}): ReactNode {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  useEffect(() => {
    if (copied !== "copied") return;
    const timer = setTimeout(() => setCopied(null), 2000);
    return () => clearTimeout(timer);
  }, [copied]);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center gap-2">
        <a
          href={link.url}
          target="_blank"
          rel="noreferrer"
          className={buttonVariants({ size: "sm" })}
        >
          <ExternalLink />
          Open {link.name}'s sign-in page
        </a>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() => {
            navigator.clipboard.writeText(link.url).then(
              () => setCopied("copied"),
              () => setCopied("failed"),
            );
          }}
        >
          {copied === "copied" ? <Check /> : <Copy />}
          {copied === "copied" ? "Copied" : "Copy link"}
        </Button>
      </div>
      {copied === "failed" && (
        <input
          readOnly
          aria-label="The sign-in page's address"
          value={link.url}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full rounded-md border border-l3 bg-transparent px-2 py-1 font-mono text-xs text-t1"
        />
      )}
      {instructions !== undefined && <p className="text-sm text-t2">{instructions}</p>}
    </div>
  );
}
