# 04: Space settings → Archive y Scheduled tasks

**What to build:** `/settings/archived` (`ArchivedThreadsPanel`) y `/settings/scheduled-tasks` (`ScheduledTasksSettings`) pasan a Space → Archive y Space → Scheduled tasks, filtrados al Space del modal. Se quita su selector de alcance por Project y máquina: el alcance es el Space.

**Blocked by:** 03

**Status:** ready-for-agent

Spec: ../spec.md

- [ ] Archive lista solo Threads y Projects archivados del Space; restaurar y borrar siguen las reglas de hoy.
- [ ] Scheduled tasks lista solo las tareas de Threads del Space que el User puede ver (`visibleScheduledTasks.ts` sigue mandando en el servidor).
- [ ] `/settings/archived` y `/settings/scheduled-tasks` redirigen al Space actual.
- [ ] `ThreadAutomationsPanel.tsx`, `QueuedRunsControl.tsx` y `TimelineUserMessageRow.tsx` llevan a Space → Scheduled tasks del Space del Thread.
- [ ] `ScheduledTasksSettings.browser.test.tsx` se adapta a la ruta nueva sin duplicarse.
