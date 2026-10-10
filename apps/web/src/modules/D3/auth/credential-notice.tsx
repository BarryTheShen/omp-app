import { useEffect, useState } from "react";
import { InlineError } from "@/components/blocks";
import { Button } from "@/components/ui/button";
import type { ProviderSignIn } from "../contract";
import type { CredentialFailure } from "./credential";
import { useCredentialActions } from "./credential-actions";

/**
 * The notice's sentence: what was refused, by which provider and model, and the way out. It names the
 * sign-in only as far as the app can tell it (a stored login, or an API key), and never shows a status code.
 */
export function credentialNoticeMessage(
  failure: CredentialFailure,
  signIn: ProviderSignIn | undefined,
): string {
  const provider = failure.provider ?? "the provider";
  const model = failure.model ?? "the model";
  if (signIn === "login") {
    return `omp used your ${provider} login, and ${provider} did not accept it, so ${model} could not answer. Sign in to ${provider} again, or choose another model.`;
  }
  if (signIn === "api-key") {
    return `omp used an API key for ${provider}, not your login, and ${provider} did not accept it, so ${model} could not answer. Choose another model, or sign in to ${provider}.`;
  }
  return `${provider} did not accept the sign-in, so ${model} could not answer. Choose another model, or sign in to ${provider}.`;
}

/**
 * Why an answer stopped because the provider refused the key or login: plain words, the two ways out
 * (another model, sign in), and omp's own words only behind "Show details".
 */
export function CredentialFailureNotice({
  failure,
  variant = "message",
}: {
  readonly failure: CredentialFailure;
  readonly variant?: "default" | "message";
}) {
  const actions = useCredentialActions();
  const { readSignIns } = actions;
  const provider = failure.provider;
  const [signIn, setSignIn] = useState<ProviderSignIn | undefined>(undefined);

  useEffect(() => {
    if (readSignIns === undefined || provider === undefined) return;
    let active = true;
    void readSignIns().then((signIns) => {
      if (active) setSignIn(signIns.get(provider));
    });
    return () => {
      active = false;
    };
  }, [readSignIns, provider]);

  const { chooseModel, signIn: openSignIn } = actions;
  const buttons =
    chooseModel === undefined && openSignIn === undefined ? undefined : (
      <>
        {chooseModel === undefined ? null : (
          <Button type="button" size="sm" variant="outline" onClick={() => chooseModel()}>
            Choose another model
          </Button>
        )}
        {openSignIn === undefined ? null : (
          <Button
            type="button"
            size="sm"
            variant="outline"
            title={provider === undefined ? "Sign in to a provider" : `Sign in to ${provider}`}
            onClick={() => openSignIn(provider)}
          >
            Sign in…
          </Button>
        )}
      </>
    );

  return (
    <InlineError
      heading="The model could not sign in"
      message={credentialNoticeMessage(failure, signIn)}
      variant={variant}
      actions={buttons}
      details={failure.text === "" ? undefined : failure.text}
    />
  );
}
