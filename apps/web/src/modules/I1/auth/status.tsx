import type { McpServerAuthViewModel } from "./capabilities";

export function McpServerAuthStatus({ viewModel }: { readonly viewModel: McpServerAuthViewModel }) {
  return (
    <div className="space-y-1 text-sm" data-mcp-auth-status>
      <p>Authentication type: {viewModel.authenticationType}.</p>
      <p>Server connection: {viewModel.connectionStatus}.</p>
      {viewModel.unavailableReason ? (
        <p role="status" className="text-muted-foreground">
          {viewModel.unavailableReason}
        </p>
      ) : null}
    </div>
  );
}
