import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_chat/settings/platform/")({
  beforeLoad: () => {
    throw redirect({
      to: "/settings/platform/$section",
      params: { section: "users" },
      search: true,
      hash: true,
      replace: true,
    });
  },
});
