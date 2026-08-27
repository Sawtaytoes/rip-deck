import { createApiServer } from "/mnt/TrueNAS-Apps/Repos/rip-deck/.worktrees/history/packages/daemon/src/api/server.ts"
import { createTowerStore } from "/mnt/TrueNAS-Apps/Repos/rip-deck/.worktrees/history/packages/daemon/src/api/snapshot.ts"
import { backfillRipHistory } from "/mnt/TrueNAS-Apps/Repos/rip-deck/.worktrees/history/packages/daemon/src/rip/ripHistoryBackfill.ts"
import { loadDriveRegistry } from "/mnt/TrueNAS-Apps/Repos/rip-deck/.worktrees/history/packages/daemon/src/drives/registry.ts"

console.log(await backfillRipHistory({
  stateDir: "/tmp/rd-after-61043",
  registry: await loadDriveRegistry("/mnt/TrueNAS-Apps/App-Configs/rip-deck/config/drives.json").catch(() => null),
}))

const store = createTowerStore()
const api = createApiServer({
  readSnapshot: () => store.readSnapshot(),
  port: 5471,
  host: "127.0.0.1",
  stateDir: "/tmp/rd-after-61043",
})
await api.listen()
console.log("listening on 5471")
