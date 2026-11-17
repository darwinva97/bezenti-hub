import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/space/$spaceId/machines/$environmentId/")({
  beforeLoad: ({ params }) => {
    throw redirect({
      to: "/settings/space/$spaceId/machines/$environmentId/$machineSection",
      params: { ...params, machineSection: "providers" },
      search: true,
      hash: true,
      replace: true,
    });
  },
});
