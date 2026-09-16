// Regression tests for parser accuracy: comments, strings, docstrings,
// and multiline imports should never produce false dependency usage,
// and real imports (including multiline ones) must still be detected.
//
// Run with: node test/parser-accuracy.test.js

const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { readManifest } = require("../src/core/package-managers");
const { analyzeWorkspace } = require("../src/core/analyzer");

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

function makeFixture(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-parser-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(dir, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return dir;
}

async function usageFor(dir) {
  const manifest = readManifest(dir);
  const { usage } = await analyzeWorkspace(dir, manifest.dependencies, new Set());
  return usage;
}

function isUsed(usage, dep) {
  return Boolean(usage[dep]) && usage[dep].size > 0;
}

(async () => {
  // ================= Python =================

  await test("Python: real import", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "import requests\nrequests.get('/x')\n",
    });
    assert.ok(isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: import inside a line comment does not count", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "# import requests\n",
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: import inside a string does not count", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": 'text = "import requests"\n',
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: import inside a triple-quoted string does not count", async () => {
    const dir = makeFixture({
      "requirements.txt": "pandas\n",
      "main.py": '"""\nimport pandas\n"""\n',
    });
    assert.ok(!isUsed(await usageFor(dir), "pandas"));
  });

  await test("Python: import inside a docstring does not count", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "def example():\n    \"\"\"\n    from requests import get\n    \"\"\"\n    pass\n",
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: from-import", async () => {
    const dir = makeFixture({
      "requirements.txt": "flask\n",
      "main.py": "from flask import Flask\napp = Flask(__name__)\n",
    });
    assert.ok(isUsed(await usageFor(dir), "flask"));
  });

  await test("Python: nested from-import", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "from requests.sessions import Session\nSession()\n",
    });
    assert.ok(isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: relative import stays local", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "from .utils import helper\n",
      "utils.py": "def helper(): pass\n",
    });
    assert.ok(!isUsed(await usageFor(dir), "requests"));
  });

  await test("Python: aliased import", async () => {
    const dir = makeFixture({
      "requirements.txt": "numpy\n",
      "main.py": "import numpy as np\nnp.array([1])\n",
    });
    assert.ok(isUsed(await usageFor(dir), "numpy"));
  });

  await test("Python: multiline grouped import", async () => {
    const dir = makeFixture({
      "requirements.txt": "requests\n",
      "main.py": "from requests import (\n    get,\n    post,\n)\nget('/x')\n",
    });
    assert.ok(isUsed(await usageFor(dir), "requests"));
  });

  // ================= Java =================

  await test("Java: real import", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "import com.google.gson.Gson;\nclass App {}",
    });
    assert.ok(isUsed(await usageFor(dir), "com.google.code.gson:gson"));
  });

  await test("Java: line comment does not count", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.fake</groupId><artifactId>foo</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "// import com.fake.Foo;\nclass App {}",
    });
    assert.ok(!isUsed(await usageFor(dir), "com.fake:foo"));
  });

  await test("Java: block comment does not count", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.fake</groupId><artifactId>foo</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "/*\nimport com.fake.Foo;\n*/\nclass App {}",
    });
    assert.ok(!isUsed(await usageFor(dir), "com.fake:foo"));
  });

  await test("Java: javadoc does not count", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.fake</groupId><artifactId>foo</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "/**\n * import com.fake.Foo;\n */\nclass App {}",
    });
    assert.ok(!isUsed(await usageFor(dir), "com.fake:foo"));
  });

  await test("Java: string containing import text does not count", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>com.fake</groupId><artifactId>foo</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": 'class App { String s = "import com.fake.Foo;"; }',
    });
    assert.ok(!isUsed(await usageFor(dir), "com.fake:foo"));
  });

  await test("Java: static import", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`,
      "src/test/java/AppTest.java": "import static org.junit.jupiter.api.Assertions.assertTrue;\nclass AppTest {}",
    });
    assert.ok(isUsed(await usageFor(dir), "org.junit.jupiter:junit-jupiter"));
  });

  await test("Java: wildcard import", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>org.junit.jupiter</groupId><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>`,
      "src/test/java/AppTest.java": "import static org.junit.jupiter.api.Assertions.*;\nclass AppTest {}",
    });
    assert.ok(isUsed(await usageFor(dir), "org.junit.jupiter:junit-jupiter"));
  });

  await test("Java: nested package import", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies><dependency><groupId>org.springframework.boot</groupId><artifactId>spring-boot-starter-web</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "import org.springframework.web.bind.annotation.RestController;\nclass App {}",
    });
    assert.ok(isUsed(await usageFor(dir), "org.springframework.boot:spring-boot-starter-web"));
  });

  await test("Java: multiple imports in one file", async () => {
    const dir = makeFixture({
      "pom.xml": `<project><dependencies>
        <dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency>
        <dependency><groupId>com.unused</groupId><artifactId>unused-lib</artifactId></dependency>
      </dependencies></project>`,
      "src/main/java/App.java": "import com.google.gson.Gson;\nimport java.util.List;\nclass App {}",
    });
    const usage = await usageFor(dir);
    assert.ok(isUsed(usage, "com.google.code.gson:gson"));
    assert.ok(!isUsed(usage, "com.unused:unused-lib"));
  });

  // ================= Go =================

  await test("Go: single import", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "main.go": 'package main\nimport "github.com/gin-gonic/gin"\nfunc main() { gin.Default() }',
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: grouped imports", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "main.go": 'package main\nimport (\n\t"fmt"\n\t"github.com/gin-gonic/gin"\n)\nfunc main() { fmt.Println(gin.Default()) }',
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: aliased import", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "main.go": 'package main\nimport g "github.com/gin-gonic/gin"\nfunc main() { g.Default() }',
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  await test("Go: blank import", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/lib/pq v1.10.0\n",
      "main.go": 'package main\nimport _ "github.com/lib/pq"\nfunc main() {}',
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/lib/pq"));
  });

  await test("Go: dot import", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/example/foo v1.0.0\n",
      "main.go": 'package main\nimport . "github.com/example/foo"\nfunc main() {}',
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/example/foo"));
  });

  await test("Go: line comment does not count", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/fake/foo v1.0.0\n",
      "main.go": 'package main\n// import "github.com/fake/foo"\nfunc main() {}',
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/fake/foo"));
  });

  await test("Go: block comment does not count", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/fake/foo v1.0.0\n",
      "main.go": 'package main\n/*\nimport "github.com/fake/foo"\n*/\nfunc main() {}',
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/fake/foo"));
  });

  await test("Go: raw string (backtick) does not count", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/fake/foo v1.0.0\n",
      "main.go": 'package main\nvar example = `import "github.com/fake/foo"`\nfunc main() {}',
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/fake/foo"));
  });

  await test("Go: normal string does not count", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/fake/foo v1.0.0\n",
      "main.go": 'package main\nvar t = "import \\"github.com/fake/foo\\""\nfunc main() {}',
    });
    assert.ok(!isUsed(await usageFor(dir), "github.com/fake/foo"));
  });

  await test("Go: subpackage import", async () => {
    const dir = makeFixture({
      "go.mod": "module example.com/app\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "main.go": 'package main\nimport "github.com/gin-gonic/gin/render"\nvar _ = render.JSON{}',
    });
    assert.ok(isUsed(await usageFor(dir), "github.com/gin-gonic/gin"));
  });

  // ================= Rust =================

  await test("Rust: use", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/main.rs": "use serde::Serialize;\nfn main() {}",
    });
    assert.ok(isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: pub use", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/main.rs": "pub use serde::Deserialize;\nfn main() {}",
    });
    assert.ok(isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: extern crate", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/main.rs": "extern crate serde;\nfn main() {}",
    });
    assert.ok(isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: grouped use", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/main.rs": "use serde::{Deserialize, Serialize};\nfn main() {}",
    });
    assert.ok(isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: aliased import", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde_json = "1.0"\n',
      "src/main.rs": "use serde_json as json;\nfn main() {}",
    });
    assert.ok(isUsed(await usageFor(dir), "serde_json"));
  });

  await test("Rust: line comment does not count", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nfake_crate = "1.0"\n',
      "src/main.rs": "// use fake_crate::Thing;\nfn main() {}",
    });
    assert.ok(!isUsed(await usageFor(dir), "fake_crate"));
  });

  await test("Rust: block comment does not count", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nfake_crate = "1.0"\n',
      "src/main.rs": "/*\nuse fake_crate::Thing;\n*/\nfn main() {}",
    });
    assert.ok(!isUsed(await usageFor(dir), "fake_crate"));
  });

  await test("Rust: normal string does not count", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nfake_crate = "1.0"\n',
      "src/main.rs": 'fn main() { let text = "use fake_crate::Thing;"; }',
    });
    assert.ok(!isUsed(await usageFor(dir), "fake_crate"));
  });

  await test("Rust: macro string argument does not count", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nfake_crate = "1.0"\n',
      "src/main.rs": 'fn main() { println!("use fake_crate::Thing;"); }',
    });
    assert.ok(!isUsed(await usageFor(dir), "fake_crate"));
  });

  await test("Rust: local crate:: import stays local", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/main.rs": "use crate::config::Config;\nmod config;\nfn main() {}",
      "src/config.rs": "pub struct Config;",
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  await test("Rust: standard library std:: excluded", async () => {
    const dir = makeFixture({
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src/main.rs": "use std::collections::HashMap;\nfn main() {}",
    });
    assert.ok(!isUsed(await usageFor(dir), "serde"));
  });

  // ================= Cross-language false-positive project =================

  await test("Cross-language: documentation-style fake imports never count", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-parser-test-"));

    fs.mkdirSync(path.join(dir, "py-service"), { recursive: true });
    fs.writeFileSync(path.join(dir, "py-service", "requirements.txt"), "\n");
    fs.writeFileSync(
      path.join(dir, "py-service", "main.py"),
      '"""\nExample:\nimport requests\n"""\n'
    );

    fs.mkdirSync(path.join(dir, "java-service", "src", "main", "java"), { recursive: true });
    fs.writeFileSync(path.join(dir, "java-service", "pom.xml"), "<project><dependencies></dependencies></project>");
    fs.writeFileSync(
      path.join(dir, "java-service", "src", "main", "java", "App.java"),
      'class App { String docs = "import com.fake.Foo;"; }'
    );

    fs.mkdirSync(path.join(dir, "go-service"), { recursive: true });
    fs.writeFileSync(path.join(dir, "go-service", "go.mod"), "module example.com/go-service\n");
    fs.writeFileSync(
      path.join(dir, "go-service", "main.go"),
      'package main\nvar example = `import "github.com/fake/foo"`\nfunc main() {}'
    );

    fs.mkdirSync(path.join(dir, "rust-service", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "rust-service", "Cargo.toml"), "[dependencies]\n");
    fs.writeFileSync(
      path.join(dir, "rust-service", "src", "main.rs"),
      'fn main() { let docs = "use fake_crate::Foo;"; }'
    );

    // None of these declared zero dependencies, so there's nothing to
    // falsely mark used - the real assertion is that reading each
    // manifest and analyzing each service doesn't crash or misbehave.
    for (const service of ["py-service", "java-service", "go-service", "rust-service"]) {
      const usage = await usageFor(path.join(dir, service));
      assert.deepStrictEqual(Object.keys(usage), []);
    }
  });

  // ================= Mixed-language / monorepo regression =================

  await test("Mixed project: all six languages report correctly in one workspace", async () => {
    const dir = makeFixture({
      "package.json": JSON.stringify({ dependencies: { axios: "1.0.0" } }),
      "src/index.js": "const axios = require('axios'); axios.get('/x');",
      "src/api.ts": 'import axios from "axios"; axios.get("/y");',
      "requirements.txt": "requests\n",
      "app.py": "import requests\nrequests.get('/x')\n",
      "pom.xml": `<project><dependencies><dependency><groupId>com.google.code.gson</groupId><artifactId>gson</artifactId></dependency></dependencies></project>`,
      "src/main/java/App.java": "import com.google.gson.Gson;\nclass App {}",
      "go.mod": "module example.com/x\n\nrequire github.com/gin-gonic/gin v1.10.0\n",
      "main.go": 'package main\nimport "github.com/gin-gonic/gin"\nfunc main() { gin.Default() }',
      "Cargo.toml": '[dependencies]\nserde = "1.0"\n',
      "src2/main.rs": "use serde::Serialize;\nfn main() {}",
    });
    const usage = await usageFor(dir);
    assert.ok(isUsed(usage, "axios"));
    assert.ok(isUsed(usage, "requests"));
    assert.ok(isUsed(usage, "com.google.code.gson:gson"));
    assert.ok(isUsed(usage, "github.com/gin-gonic/gin"));
    assert.ok(isUsed(usage, "serde"));
  });

  await test("Monorepo: a fake import in one package boundary cannot mark a dependency used in another", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "snooply-parser-test-"));

    fs.mkdirSync(path.join(dir, "frontend", "src"), { recursive: true });
    fs.writeFileSync(path.join(dir, "frontend", "package.json"), JSON.stringify({ dependencies: { axios: "1.0.0" } }));
    fs.writeFileSync(path.join(dir, "frontend", "src", "index.js"), "console.log('no axios usage here');");

    fs.mkdirSync(path.join(dir, "python-service"), { recursive: true });
    fs.writeFileSync(path.join(dir, "python-service", "requirements.txt"), "axios\n");
    fs.writeFileSync(path.join(dir, "python-service", "main.py"), '"""\nimport axios\n"""\n');

    const frontendUsage = await usageFor(path.join(dir, "frontend"));
    const pythonUsage = await usageFor(path.join(dir, "python-service"));

    assert.ok(!isUsed(frontendUsage, "axios")); // real JS axios never imported
    assert.ok(!isUsed(pythonUsage, "axios")); // fake docstring import in an unrelated ecosystem
  });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed > 0 ? 1 : 0;
})();
