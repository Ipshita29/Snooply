// Regression tests for dependency <-> import matching across all six
// languages. Builds small real fixture projects in a scratch directory
// and runs the actual analyzer pipeline (readManifest + analyzeWorkspace)
// against them - the same code path the CLI uses, not a parallel
// re-implementation of matching logic.
//
// Run with: node test/matching.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { readManifest } = require("../src/package-managers");
const { analyzeWorkspace } = require("../src/analyze");

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`ok - ${name}`);
  } catch (error) {
    failed++;
    console.log(`FAIL - ${name}`);
    console.log(`  ${error.message}`);
  }
}

// Write a small fixture project to a fresh temp directory
function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

// Run the real analyzer pipeline against a fixture directory
async function usageFor(dir) {
  const manifest = readManifest(dir);
  const { usage } = await analyzeWorkspace(dir, manifest.dependencies, new Set());
  return usage;
}

function isUsed(usage, dep) {
  return Boolean(usage[dep]) && usage[dep].size > 0;
}

(async () => {
  // ================= JavaScript =================

  await test("JS: normal package", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": `const { debounce } = require("lodash"); debounce();`,
    });
    assert.ok(isUsed(await usageFor(dir), "lodash"));
  });

  await test("JS: subpath import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": `const debounce = require("lodash/debounce");`,
    });
    assert.ok(isUsed(await usageFor(dir), "lodash"));
  });

  await test("JS: scoped package", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { "@tanstack/react-query": "1.0.0" } }),
      "index.js": `import { useQuery } from "@tanstack/react-query";`,
    });
    assert.ok(isUsed(await usageFor(dir), "@tanstack/react-query"));
  });

  await test("JS: bare dynamic import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { lodash: "1.0.0" } }),
      "index.js": `import("lodash");`,
    });
    assert.ok(isUsed(await usageFor(dir), "lodash"));
  });

  await test("JS: genuinely unused package", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.js": `console.log("hi");`,
    });
    assert.ok(!isUsed(await usageFor(dir), "axios"));
  });

  await test("JS: package boundary safety (foo vs foobar)", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { foo: "1.0.0" } }),
      "index.js": `require("foobar");`,
    });
    assert.ok(!isUsed(await usageFor(dir), "foo"));
  });

  await test("JS: scoped package boundary safety (@scope/foo vs @scope/foobar)", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { "@scope/foo": "1.0.0" } }),
      "index.js": `require("@scope/foobar");`,
    });
    assert.ok(!isUsed(await usageFor(dir), "@scope/foo"));
  });

  // ================= TypeScript =================

  await test("TS: type-only import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { "some-types": "1.0.0" } }),
      "index.ts": `import type { Foo } from "some-types";`,
    });
    assert.ok(isUsed(await usageFor(dir), "some-types"));
  });

  await test("TS: subpath import", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { "@babel/parser": "1.0.0" } }),
      "index.ts": `import x from "@babel/parser/lib/index.js";`,
    });
    assert.ok(isUsed(await usageFor(dir), "@babel/parser"));
  });

  await test("TS: genuinely unused package", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "index.ts": `const x: number = 1;`,
    });
    assert.ok(!isUsed(await usageFor(dir), "axios"));
  });

  // ================= Python =================

  await test("Python: distribution/import mismatch (beautifulsoup4 -> bs4)", async () => {
    const dir = makeFixture({
      "requirements.txt": "beautifulsoup4\n",
      "main.py": "from bs4 import BeautifulSoup\n",
    });
    assert.ok(isUsed(await usageFor(dir), "beautifulsoup4"));
  });

  await test("Python: opencv-python -> cv2", async () => {
    const dir = makeFixture({
      "requirements.txt": "opencv-python\n",
      "main.py": "import cv2\n",
    });
    assert.ok(isUsed(await usageFor(dir), "opencv-python"));
  });

  await test("Python: PyYAML -> yaml", async () => {
    const dir = makeFixture({
      "requirements.txt": "PyYAML\n",
      "main.py": "import yaml\n",
    });
    assert.ok(isUsed(await usageFor(dir), "PyYAML"));
  });

  await test("Python: standard library excluded", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "import os\nimport json\n",
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: relative import stays local", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "from .utils import helper\n",
      "utils.py": "def helper(): pass\n",
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: genuinely unused among declared dependencies", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\npandas\n",
      "main.py": "import requests\nrequests.get('/x')\n",
    });
    const usage = await usageFor(dir);
    assert.ok(isUsed(usage, "requests"));
    assert.ok(!isUsed(usage, "pandas"));
  });

  await test("Python: distribution/import mismatch (Pillow -> PIL)", async () => {
    const dir = makeFixture({
      "requirements.txt": "Pillow\n",
      "main.py": "from PIL import Image\nImage.open('x.png')\n",
    });
    assert.ok(isUsed(await usageFor(dir), "Pillow"));
  });

  await test("Python: distribution/import mismatch (scikit-learn -> sklearn)", async () => {
    const dir = makeFixture({
      "requirements.txt": "scikit-learn\n",
      "main.py": "import sklearn\nsklearn.__version__\n",
    });
    assert.ok(isUsed(await usageFor(dir), "scikit-learn"));
  });

  await test("Python: double-level relative import stays local", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "pkg/mod.py": "from ..shared import bar\n",
      "shared.py": "def bar(): pass\n",
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  // ================= Java =================

  await test("Java: Maven coordinate -> package namespace (gson)", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": `import com.google.gson.Gson;\nclass App {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "com.google.code.gson:gson"));
  });

  await test("Java: Gradle coordinate -> package namespace (spring-boot-starter-web)", async () => {
    const dir = makeFixture({
      "build.gradle": `dependencies {\n    implementation 'org.springframework.boot:spring-boot-starter-web:3.3.0'\n}\n`,
      "src/main/java/App.java": `import org.springframework.web.bind.annotation.RestController;\nclass App {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "org.springframework.boot:spring-boot-starter-web"));
  });

  await test("Java: wildcard import (junit-jupiter)", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`,
      "src/test/java/AppTest.java": `import static org.junit.jupiter.api.Assertions.*;\nclass AppTest {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "org.junit.jupiter:junit-jupiter"));
  });

  await test("Java: standard library excluded", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": `import java.util.List;\nclass App {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "com.google.code.gson:gson"));
  });

  await test("Java: genuinely unused dependency", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.unused</groupId><artifactId>unused-lib</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": `class App {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "com.unused:unused-lib"));
  });

  await test("Java: dependencies sharing a namespace are both credited", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies>
        <dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency>
        <dependency><groupId>org.springframework</groupId><artifactId>spring-context</artifactId></dependency>
      </dependencies></project>`,
      "src/main/java/App.java": `import org.springframework.stereotype.Component;\nclass App {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "org.springframework:spring-context"));
  });

  await test("Java: Gradle Kotlin DSL (build.gradle.kts) coordinate -> package namespace", async () => {
    const dir = makeFixture({
      "build.gradle.kts": `dependencies {\n    implementation("com.google.code.gson:gson:2.10.1")\n}\n`,
      "src/main/java/App.java": `import com.google.gson.Gson;\nclass App {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "com.google.code.gson:gson"));
  });

  // Note: the groupId fallback intentionally credits every subpackage
  // under a matched groupId (e.g. com.example.* all count for a
  // com.example:* dependency) - that's a deliberate, documented
  // trade-off (see ARTIFACT_TO_NAMESPACE / resolveTrackedPackages),
  // not a false match. The actual boundary risk is a sibling groupId
  // that merely shares a string prefix without a real "." boundary.
  await test("Java: package boundary safety (com.example vs com.example2 groupId)", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.example</groupId><artifactId>foo</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": `import com.example2.Widget;\nclass App {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "com.example:foo"));
  });

  // ================= Go =================

  await test("Go: module path -> import", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n`,
      "main.go": `package main\nimport "github.com/gin-gonic/gin"\nfunc main() { gin.Default() }`,
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: subpackage import", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n`,
      "main.go": `package main\nimport "github.com/gin-gonic/gin/render"\nvar _ = render.JSON{}`,
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: v1 dependency does not match a /v2 import", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/example/foo v1.0.0\n`,
      "main.go": `package main\nimport "github.com/example/foo/v2/client"\nvar _ = client.New`,
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/example/foo"));
  });

  await test("Go: declared /v2 module matches its own /v2 import", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/example/foo/v2 v2.1.0\n`,
      "main.go": `package main\nimport "github.com/example/foo/v2/client"\nvar _ = client.New`,
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/example/foo/v2"));
  });

  await test("Go: local module import excluded", async () => {
    const dir = makeFixture({
      "go.mod": `module github.com/myuser/myapp\n\nrequire github.com/gin-gonic/gin v1.10.0\n`,
      "main.go": `package main\nimport "github.com/myuser/myapp/internal/config"\nvar _ = config.X`,
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: standard library excluded", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n`,
      "main.go": `package main\nimport (\n"fmt"\n"net/http"\n)\nfunc main() { fmt.Println(http.StatusOK) }`,
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: genuinely unused dependency", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire (\n  github.com/gin-gonic/gin v1.10.0\n  github.com/stretchr/testify v1.9.0\n)\n`,
      "main.go": `package main\nimport "github.com/gin-gonic/gin"\nfunc main() { gin.Default() }`,
    });
    const usage = await usageFor(dir);
    assert.ok(isUsed(usage, "github.com/gin-gonic/gin"));
    assert.ok(!isUsed(usage, "github.com/stretchr/testify"));
  });

  await test("Go: similar module names do not collide", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/example/foo v1.0.0\n`,
      "main.go": `package main\nimport "github.com/example/foobar"\nvar _ = foobar.X`,
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/example/foo"));
  });

  await test("Go: vendor directory is excluded from source scanning", async () => {
    const dir = makeFixture({
      "go.mod": `module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n`,
      "main.go": `package main\nfunc main() {}`,
      "vendor/github.com/gin-gonic/gin/gin.go": `package gin\nimport "github.com/gin-gonic/gin"\nfunc Default() {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  // ================= Rust =================

  await test("Rust: normal crate", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `use serde::Serialize;\nfn main() {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: hyphen/underscore normalization", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nsome-crate = "1.0"\n`,
      "src/main.rs": `use some_crate::Thing;\nfn main() {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "some-crate"));
  });

  await test("Rust: renamed dependency", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nmy_json = { package = "serde_json", version = "1.0" }\n`,
      "src/main.rs": `use my_json::Value;\nfn main() {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "my_json"));
  });

  await test("Rust: standard library excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `use std::collections::HashMap;\nfn main() {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: local module (crate::) excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `use crate::config::Config;\nmod config;\nfn main() {}`,
      "src/config.rs": `pub struct Config;`,
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: genuinely unused crate", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\nunused-crate = "1.0"\n`,
      "src/main.rs": `use serde::Serialize;\nfn main() {}`,
    });
    const usage = await usageFor(dir);
    assert.ok(isUsed(usage, "serde"));
    assert.ok(!isUsed(usage, "unused-crate"));
  });

  await test("Rust: nested grouped use", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `use serde::{de::{self, Deserializer}, Serialize};\nfn main() {}`,
    });
    assert.ok(isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: self:: local import excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `mod config;\nuse self::config::Config;\nfn main() {}`,
      "src/config.rs": `pub struct Config;`,
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: super:: local import excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `mod util;\nfn main() {}`,
      "src/util.rs": `use super::helper;\nfn helper() {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: core:: standard library excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `use core::mem::swap;\nfn main() {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: alloc:: standard library excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": `[dependencies]\nserde = "1.0"\n`,
      "src/main.rs": `use alloc::vec::Vec;\nfn main() {}`,
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  // ================= Mixed-language / multi-package =================

  await test("Mixed languages combine in one workspace", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "src/api.js": `const axios = require("axios"); axios.get("/x");`,
      "requirements.txt": "requests\n",
      "app.py": "import requests\nrequests.get('/x')\n",
    });
    const usage = await usageFor(dir);
    assert.ok(isUsed(usage, "axios"));
    assert.ok(isUsed(usage, "requests"));
  });

  await test("Multi-package: dependencies never cross package boundaries", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-test-"));
    fs.mkdirSync(path.join(dir, "frontend"), { recursive: true });
    fs.mkdirSync(path.join(dir, "backend-python", "app"), { recursive: true });
    fs.writeFileSync(path.join(dir, "frontend", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "frontend", "index.js"), `const axios = require("axios"); axios.get("/x");`);
    // Same name declared in an unrelated ecosystem, never actually imported there
    fs.writeFileSync(path.join(dir, "backend-python", "requirements.txt"), "axios\n");
    fs.writeFileSync(path.join(dir, "backend-python", "app", "main.py"), `print("hi")`);

    const frontendUsage = await usageFor(path.join(dir, "frontend"));
    const backendUsage = await usageFor(path.join(dir, "backend-python"));
    assert.ok(isUsed(frontendUsage, "axios"));
    assert.ok(!isUsed(backendUsage, "axios"));
  });

  await test("Monorepo: same-ecosystem client/server packages stay isolated", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-test-"));
    fs.mkdirSync(path.join(dir, "client"), { recursive: true });
    fs.mkdirSync(path.join(dir, "server"), { recursive: true });
    fs.writeFileSync(path.join(dir, "client", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "client", "index.js"), `const axios = require("axios"); axios.get("/x");`);
    // Same npm dependency declared on the server side, but never imported there
    fs.writeFileSync(path.join(dir, "server", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "server", "index.js"), `console.log("hi");`);

    const clientUsage = await usageFor(path.join(dir, "client"));
    const serverUsage = await usageFor(path.join(dir, "server"));
    assert.ok(isUsed(clientUsage, "axios"));
    assert.ok(!isUsed(serverUsage, "axios"));
  });

  await test("Monorepo: apps/web + apps/admin + packages/shared each analyze independently", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-test-"));
    fs.mkdirSync(path.join(dir, "apps", "web", "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "apps", "admin", "src"), { recursive: true });
    fs.mkdirSync(path.join(dir, "packages", "shared", "src"), { recursive: true });

    fs.writeFileSync(
      path.join(dir, "apps", "web", "package.json"),
      JSON.stringify({ dependencies: { react: "18.2.0", lodash: "1.0.0" } })
    );
    fs.writeFileSync(
      path.join(dir, "apps", "web", "src", "index.js"),
      `const React = require("react"); React.createElement("div");`
    );

    fs.writeFileSync(path.join(dir, "apps", "admin", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "apps", "admin", "src", "index.js"), `const axios = require("axios"); axios.get("/x");`);

    fs.writeFileSync(path.join(dir, "packages", "shared", "package.json"), JSON.stringify({ dependencies: { dayjs: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "packages", "shared", "src", "index.js"), `const dayjs = require("dayjs"); dayjs();`);

    const webUsage = await usageFor(path.join(dir, "apps", "web"));
    const adminUsage = await usageFor(path.join(dir, "apps", "admin"));
    const sharedUsage = await usageFor(path.join(dir, "packages", "shared"));

    assert.ok(isUsed(webUsage, "react"));
    assert.ok(!isUsed(webUsage, "lodash"), "lodash is declared in apps/web but never imported there");
    assert.ok(isUsed(adminUsage, "axios"));
    assert.ok(isUsed(sharedUsage, "dayjs"));
    // No cross-boundary leakage between the three packages
    assert.ok(!isUsed(adminUsage, "react"));
    assert.ok(!isUsed(sharedUsage, "axios"));
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
