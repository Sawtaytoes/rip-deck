import { describe, expect, it } from "vitest"

import { buildOperatorLog } from "./operatorLog"

describe("buildOperatorLog", () => {
  it("keeps stages and warnings while removing progress telemetry", () => {
    const capture = [
      'MSG:1005,0,1,"MakeMKV started"',
      'PRGT:5018,0,"Scanning CD-ROM devices"',
      'PRGC:5018,0,"Scanning CD-ROM devices"',
      "PRGV:0,0,65536",
      'MSG:2008,32,0,"Program reads data faster than it can write to disk"',
      "PRGV:1,2,65536",
      "[rip-deck] result=failed reason=stall_timeout termination=stall_timeout exit=143 kernel_io_errors=12 makemkv_read_errors=0",
    ].join("\n")

    expect(buildOperatorLog(capture)).toBe(
      [
        "Stage: Scanning CD-ROM devices",
        'MSG:2008,32,0,"Program reads data faster than it can write to disk"',
        "[rip-deck] result=failed reason=stall_timeout termination=stall_timeout exit=143 kernel_io_errors=12 makemkv_read_errors=0",
      ].join("\n"),
    )
  })

  it("collapses repeated important messages", () => {
    const warning = 'MSG:2008,32,0,"write paused"'
    expect(buildOperatorLog(`${warning}\n${warning}`)).toBe(
      `${warning}\n[repeated 2 times]`,
    )
  })
})
