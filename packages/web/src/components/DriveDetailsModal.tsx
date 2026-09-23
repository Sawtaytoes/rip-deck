import { Dialog } from "@charcuterie/ui"

import { bareDriveModel } from "../cardFormat"
import type { BayView, Drive, Rip } from "../types"

export function DriveDetailsModal({
  bay,
  drive,
  rip,
  onClose,
}: {
  bay: BayView | null
  drive?: Drive
  rip?: Rip
  onClose: () => void
}) {
  const details =
    bay === null
      ? []
      : [
          {
            label: "Drive",
            value: bareDriveModel({
              label: bay.label,
              slot: bay.slot,
            }),
          },
          { label: "Model", value: drive?.model },
          { label: "Serial", value: drive?.serial_id },
          {
            label: "Device",
            value: bay.dev_path ?? "Not on the bus",
          },
          { label: "Drive ID", value: bay.drive_id },
          { label: "Status", value: bay.state.state },
          { label: "Disc", value: bay.state.title },
          {
            label: "Job",
            value: rip?.job_uuid ?? bay.state.job_id,
          },
        ]

  return (
    <Dialog
      heading={`Drive ${bay?.slot ?? "details"}`}
      isVisible={bay !== null}
      onClose={onClose}
      size="md"
    >
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-3">
        {details
          .filter(({ value }) => value)
          .map(({ label, value }) => (
            <div key={label} className="contents">
              <dt className="text-content-muted">
                {label}
              </dt>
              <dd className="m-0 break-words font-medium">
                {value}
              </dd>
            </div>
          ))}
      </dl>
    </Dialog>
  )
}
