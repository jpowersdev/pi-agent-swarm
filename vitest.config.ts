import * as VitestConfig from "vitest/config"

export default VitestConfig.defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
  }
})
