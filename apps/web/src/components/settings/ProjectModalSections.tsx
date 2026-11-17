import { ProjectModalContent } from "./ProjectModalContent";

export function ProjectGeneralSection() {
  return <ProjectModalContent section="general" />;
}

export function ProjectVaultsSection() {
  return <ProjectModalContent section="vaults" />;
}

export function ProjectMachineSection() {
  return <ProjectModalContent section="machine" />;
}

export function ProjectDefaultsSection() {
  return <ProjectModalContent section="defaults" />;
}

export function ProjectActionsSection() {
  return <ProjectModalContent section="actions" />;
}
