import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/space/$spaceId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/space/$spaceId/$section",
      params: { spaceId: params.spaceId, section: "general" },
      search: true,
      hash: true,
      replace: true,
    });
  },
});
