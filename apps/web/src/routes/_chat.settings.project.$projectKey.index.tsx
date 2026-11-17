import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/project/$projectKey/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/project/$projectKey/$section",
      params: { projectKey: params.projectKey, section: "general" },
      search: true,
      hash: true,
      replace: true,
    });
  },
});
