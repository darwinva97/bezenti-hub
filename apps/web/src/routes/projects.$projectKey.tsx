import { createFileRoute, redirect } from "@tanstack/react-router";
import { signedOutRoute } from "../environments/primary";

export const Route = createFileRoute("/projects/$projectKey")({
  beforeLoad: async ({ context, params }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: signedOutRoute(context.authGateState), replace: true });
    }
    throw redirect({
      to: "/settings/project/$projectKey/$section",
      params: { projectKey: params.projectKey, section: "general" },
      replace: true,
    });
  },
});
