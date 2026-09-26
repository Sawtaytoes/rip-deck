// What `vitest.vrt.config.ts` hands the capture through `provide`.
declare module "vitest" {
  export interface ProvidedContext {
    vrtActualDirectory: string
  }
}

export {}
