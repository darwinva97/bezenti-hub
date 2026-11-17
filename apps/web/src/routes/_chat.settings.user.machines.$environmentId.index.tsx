import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/user/machines/$environmentId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/user/machines/$environmentId/$machineSection",
      params: { environmentId: params.environmentId, machineSection: "providers" },
      search: true,
      hash: true,
      replace: true,
    });
  },
});
