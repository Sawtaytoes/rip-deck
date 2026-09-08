import { Skeleton } from "@charcuterie/ui"

/** App-owned loading image: CastKit pre-renders this URL into the display cache. */
export const KioskLoading = () => (
  <main
    className="rip-kiosk"
    data-scheme="dark"
    data-castkit-ready="true"
  >
    <section
      className="rip-kiosk-details"
      aria-busy="true"
      aria-label="Loading disc details"
    >
      <div className="rip-kiosk-heading">
        <h1>Disc details</h1>
      </div>
      <div className="rip-kiosk-disc">
        <Skeleton inlineSize="87px" blockSize="130px" />
        <div className="rip-kiosk-disc-info">
          <Skeleton shape="text" lineCount={2} />
          <Skeleton shape="text" lineCount={2} />
          <Skeleton blockSize="12px" />
        </div>
      </div>
      <div className="rip-kiosk-actions">
        <Skeleton blockSize="46px" />
        <Skeleton blockSize="46px" />
        <Skeleton blockSize="46px" />
        <Skeleton blockSize="46px" />
      </div>
      <p className="rip-kiosk-report" role="status">
        Loading disc details…
      </p>
    </section>
  </main>
)
