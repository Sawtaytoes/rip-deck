# The LG drives read Blu-ray at full speed and cannot read a DVD at all

Measured 2026-08-27 on a freshly power-cycled tower with no prior USB errors.

## The finding

Slots 2 and 3 are LG WH14NS40 drives. They have completed **five Blu-ray rips**
at 23–35 MB/s, the most recent two days before this was written. They have
**never completed a DVD**, and they have never got far enough to start one.

| Slot | Drive | Blu-ray | DVD |
| --- | --- | --- | --- |
| 1 | ASUS BW-16D1HT | — | 1 completed, 1 failed |
| 2 | LG WH14NS40 | **2 completed** (45.6 GB, 45.8 GB) | never started |
| 3 | LG WH14NS40 | **3 completed** (33.6 GB, 45.4 GB, 20.2 GB) | never started |
| 4 | LG WH16NS40 | — | never started |
| 5–9 | Pioneer | completed | completed |

The Pioneers rip both kinds on the same bus, through the same hub, in the same
hour. So the fault is not shared.

## ⚠️ Identify a drive by SERIAL, never by model string

Slots 2, 3 and 4 are LG drives running **OmniDrive firmware that makes them
report as `BW-16D1HT`** — an ASUS model. `config/drives.json` says so in its own
header and keys on `firmwareSerial` for exactly this reason.

A first pass at this analysis counted drive models in the robot logs, concluded
"the LG drives have never completed a rip", and was **wrong in both directions**:
it credited the ASUS with five Blu-rays that slots 2 and 3 had done, and it
credited the LG drives with nothing. The owner caught it:

> "the firmware said they were ASUS drives. You gotta look at the slot number or
> serial because the drive firmware can be cross-flashed."

The serials are the only safe key:

| Slot | Serial | True model | Reports as |
| --- | --- | --- | --- |
| 1 | `KL7M29G4410` | ASUS BW-16D1HT | `BW-16D1HT` |
| 2 | `KLROC9E1346` | LG WH14NS40 | `BW-16D1HT` |
| 3 | `KLPOC9E1117` | LG WH14NS40 | `BW-16D1HT` |
| 4 | `KL8OC9J2652` | LG WH16NS40 | `BW-16D1HT` |

`grep` a robot log for the serial, not for the model. The SCSI INQUIRY that the
kernel caches under `/sys/block/srN/device/model` still shows the LG identity, so
the two layers disagree — one more reason not to trust a model string here.

## What a DVD does in an LG drive

With a good disc, on a bus with no errors since power-on:

```
sr 28:0:0:0: [sr6] FAILED Result: hostbyte=DID_TIME_OUT cmd_age=30s
             CDB: Read(10) 28 00 00 00 02 00 00 00 02 00
usb 2-2.3.4.4.2: reset SuperSpeed USB device number 44 using xhci_hcd
```

That is **two blocks at sector 2048** — the ISO9660/UDF volume descriptor — and
the drive did not answer in 30 seconds. The kernel resets the USB device, and it
repeats. An `sg_inq` issued by hand against the same drive also never returned.

The 45 GB Blu-ray rips at 25 MB/s rule out power, cabling and hub bandwidth. The
drive answers Blu-ray reads and does not answer DVD reads.

## Why the dashboard says "type a name"

The software is behaving correctly at every step:

1. Sector 2048 is the read that produces `ID_FS_LABEL`. It times out, so udev
   records the drive's capability flags and **nothing about the disc** — no
   `ID_CDROM_MEDIA`, no `ID_FS_LABEL`.
2. `chooseDiscNameSource` therefore has no volume label and falls back to
   `makemkvcon info`.
3. That reads the same drive, hangs, and hits its 120-second timeout.
4. The bay latches `needs_attention`: *"could not read a name off this disc.
   Refusing to invent one."*

Rip Deck is refusing to name a disc that nothing can read. That refusal is
correct and must not be "fixed" by guessing a name.

## Eliminated, with the measurement that eliminated each

| Hypothesis | Verdict | Evidence |
| --- | --- | --- |
| USB bridge or enclosure | **No** | All nine drives are the identical ASMedia `ASMT1153e` (`174c:55aa`) on `usb-storage`. |
| LibreDrive firmware | **No** | Every drive runs LibreDrive mode, Pioneers included. |
| Hub depth or position | **No** | Slot 4 shares hub `2-2.3.4` with slots 5 and 6, which rip fine. |
| The USB port or cable | **No** | Blu-ray sustains 25–35 MB/s on the same drives. |
| An earlier wedge | **No** | Reproduced with zero kernel errors since the 04:51 power-on. |
| Rip Deck's disc typing | **No** | It types the DVD correctly — `dvd, 7.8 GB — makemkv` — then fails at the name. |

## Open question, and the test that answers it

The remaining suspect is the **cross-flashed firmware's DVD path**. The drives
run another model's firmware, and the Blu-ray path works while the DVD path does
not answer.

**Next test — an unprotected DVD** (a data DVD, or anything with no CSS) in slot
2 or 3:

- It reads ⇒ the DVD path works and the fault is in CSS or region handling. A
  reflash is then the likely fix.
- It also times out ⇒ the whole DVD read path is broken in that firmware. The
  fix is a reflash to stock LG firmware, or those three drives become Blu-ray
  only.

**A Blu-ray test adds nothing** — five successful Blu-ray rips are already on
record for these two drives.

## Consequence for now

Do not put DVDs in slots 2, 3 or 4. They will settle, type correctly as DVD, sit
for four minutes across two `makemkvcon info` timeouts, and land on
`needs_attention`. Slots 5–9 rip DVDs. Slots 2 and 3 are the fastest Blu-ray
drives in the rack and should be given Blu-rays.
