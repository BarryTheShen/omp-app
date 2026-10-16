import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { endingOf, MessageEndingNote } from "./message-ending";
import {
  type ProviderErrorResolver,
  ProviderErrorResolverProvider,
  useProviderError,
} from "./provider-error-resolver";

afterEach(cleanup);

function ErrorProbe({ text }: { readonly text: string }) {
  const providerError = useProviderError(text);
  const ending = endingOf(
    { role: "assistant", status: { type: "incomplete", reason: "error", error: text } },
    providerError,
  );
  if (ending === undefined) return null;
  return <MessageEndingNote ending={ending} />;
}

describe("the provider-error resolver context", () => {
  test("a rejected request leaves only the heading and a later error text is resolved", async () => {
    const resolveProviderError: ProviderErrorResolver = vi
      .fn()
      .mockRejectedValueOnce(new Error("socket closed"))
      .mockResolvedValueOnce({ message: "400 safe provider message" });
    const raw = "400 provider error\nraw-http-request=/local/request.json";
    const { rerender } = render(
      <ProviderErrorResolverProvider resolver={resolveProviderError}>
        <ErrorProbe text={raw} />
      </ProviderErrorResolverProvider>,
    );

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The model stopped with an error");
    await waitFor(() => expect(resolveProviderError).toHaveBeenCalledWith(raw));
    expect(alert.textContent).not.toContain("/local/request.json");
    expect(alert.textContent).not.toContain("Show details");

    rerender(
      <ProviderErrorResolverProvider resolver={resolveProviderError}>
        <ErrorProbe text="a later provider error" />
      </ProviderErrorResolverProvider>,
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("400 safe provider message"),
    );
    expect(resolveProviderError).toHaveBeenCalledWith("a later provider error");
  });

  test("without a resolver, the transcript error shows no raw omp words", () => {
    const raw = "400 provider error\nraw-http-request=/local/request.json";
    render(<ErrorProbe text={raw} />);
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("The model stopped with an error");
    expect(alert.textContent).not.toContain(raw);
  });
});
