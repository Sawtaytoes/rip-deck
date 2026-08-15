import { use } from "react"

import { DataSourceContext } from "../components/AppProviders"
import type { RipDeckDataSource } from "../types"

/** Whatever is answering `/json` for this tree. */
export const useDataSource = (): RipDeckDataSource =>
  use(DataSourceContext)
