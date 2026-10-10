import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import type { ProviderSignIn } from "../contract";
import type { CredentialFailure } from "./credential";
import { CredentialActionsProvider } from "./credential-actions";
import { CredentialFailureNotice, credentialNoticeMessage } from "./credential-notice";

afterEach(() => cleanup());

const RAW = "401 Invalid API key\nInvalid API key (type=INVALID_API_KEY)";
const refused: CredentialFailure = {
  httpStatus: 401,
  provider: "openai",
  model: "gpt-6-luna",
  text: RAW,
};

describe("credentialNoticeMessage", () => {
  test("an API key the app can see is named as an API key, not as the login", () => {
    expect(credentialNoticeMessage(refused, "api-key")).toBe(
      "omp used an API key for openai, not your login, and openai did not accept it, so gpt-6-luna could not answer. Choose another model, or sign in to openai.",
    );
  });

  test("a stored login is named as the login, with a way to sign in again", () => {
    expect(credentialNoticeMessage(refused, "login")).toBe(
      "omp used your openai login, and openai did not accept it, so gpt-6-luna could not answer. Sign in to openai again, or choose another model.",
    );
  });

  test("when the app cannot tell the sign-in, it says only that the provider did not accept it", () => {
    expect(credentialNoticeMessage(refused, undefined)).toBe(
      "openai did not accept the sign-in, so gpt-6-luna could not answer. Choose another model, or sign in to openai.",
    );
  });

  test("a missing provider or model is named plainly, never invented", () => {
    expect(
      credentialNoticeMessage(
        { httpStatus: 403, provider: undefined, model: undefined, text: "" },
        undefined,
      ),
    ).toBe(
      "the provider did not accept the sign-in, so the model could not answer. Choose another model, or sign in to the provider.",
    );
  });

  test("the sentence never carries a status code or omp's own words", () => {
    for (const signIn of ["login", "api-key", undefined] as const) {
      expect(credentialNoticeMessage(refused, signIn)).not.toMatch(/401|INVALID|Invalid API key/);
    }
  });
});

describe("CredentialFailureNotice", () => {
  test("offers the two ways out and keeps omp's words behind a closed Show details", () => {
    const chooseModel = vi.fn();
    const signIn = vi.fn();
    render(
      <CredentialActionsProvider value={{ chooseModel, signIn }}>
        <CredentialFailureNotice failure={refused} />
      </CredentialActionsProvider>,
    );
    expect(screen.getByText("The model could not sign in")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Choose another model" }));
    expect(chooseModel).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole("button", { name: "Sign in…" }));
    expect(signIn).toHaveBeenCalledWith("openai");

    const details = screen.getByText("Show details").closest("details");
    expect(details?.open).toBe(false);
    expect(details?.textContent).toContain("Invalid API key");
  });

  test("once the sign-in is read, the sentence says whether an API key or a login was used", async () => {
    render(
      <CredentialActionsProvider
        value={{
          readSignIns: async () => new Map<string, ProviderSignIn>([["openai", "api-key"]]),
        }}
      >
        <CredentialFailureNotice failure={refused} />
      </CredentialActionsProvider>,
    );
    await waitFor(() =>
      expect(screen.getByText(/omp used an API key for openai, not your login/)).toBeTruthy(),
    );
  });

  test("with no actions to offer it shows no buttons", () => {
    render(<CredentialFailureNotice failure={refused} />);
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.getByText("The model could not sign in")).toBeTruthy();
  });
});
