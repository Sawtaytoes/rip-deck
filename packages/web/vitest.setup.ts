import "@testing-library/jest-dom/vitest"

import { cleanup } from "@testing-library/react"
import { afterEach } from "vitest"

// Unmount between tests, explicitly. Testing Library registers
// this itself only when vitest runs with `globals: true`, and
// this repo does not — so without it every render in a file
// stacks up in one document and the second test's query finds
// the first test's card. That failure reads as a duplicate-text
// bug in the component, which is a long way from the truth.
afterEach(cleanup)
