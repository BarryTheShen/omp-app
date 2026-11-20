/**
 * A chat with no model at all opens (`session-factory.ts`), as omp's own terminal does, so a new user can sign in from
 * the app: omp signs in inside a chat. Until a model is set up, a message gets this answer instead of omp's own words,
 * which name its terminal commands.
 */
export const NO_MODEL_HINT =
  "No model is set up yet. Sign in to a provider under Settings → Providers → Sign-in (or set an API key there), choose a model in the message box, then send the message again.";
