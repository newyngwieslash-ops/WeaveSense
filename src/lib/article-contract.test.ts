import assert from "node:assert/strict";
import test from "node:test";
import { articleAdoptInput, articlePreviewInput, articleRestoreInput, articleErrorCopy } from "./article-contract.ts";

test("article inputs accept only stored IDs, digest and safe versions", () => {
  const valid = { id: "item-1", digest: "a".repeat(64), material_version: 0 };
  assert.deepEqual(articleAdoptInput.parse(valid), valid);
  assert.deepEqual(articlePreviewInput.parse({ id: valid.id }), { id: valid.id });
  assert.deepEqual(articleRestoreInput.parse({ id: valid.id, material_version: Number.MAX_SAFE_INTEGER }),
    { id: valid.id, material_version: Number.MAX_SAFE_INTEGER });
  for (const schema of [articleAdoptInput, articlePreviewInput, articleRestoreInput]) {
    const input = schema === articleAdoptInput ? valid : schema === articlePreviewInput ? { id: valid.id } : { id: valid.id, material_version: 0 };
    for (const extra of [{ url: "https://internal.example" }, { body: "untrusted" }, { cookie: "secret" }]) {
      assert.equal(schema.safeParse({ ...input, ...extra }).success, false);
    }
    for (const id of ["", "x".repeat(129), "https://example.com", "a/b", "item\n", 1, null]) {
      assert.equal(schema.safeParse({ ...input, id }).success, false);
    }
  }
  for (const material_version of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, Infinity, NaN, "0", null]) {
    assert.equal(articleAdoptInput.safeParse({ ...valid, material_version }).success, false);
    assert.equal(articleRestoreInput.safeParse({ id: valid.id, material_version }).success, false);
  }
  for (const digest of ["A".repeat(64), "a".repeat(63), "g".repeat(64), 1, null]) {
    assert.equal(articleAdoptInput.safeParse({ ...valid, digest }).success, false);
  }
});

test("article error copy is fixed and never reflects untrusted details", () => {
  assert.equal(articleErrorCopy("article_conflict"), "内容已更新，请重新读取后采用");
  assert.equal(articleErrorCopy("article_candidate_stale"), articleErrorCopy("article_conflict"));
  assert.equal(articleErrorCopy("article_timeout"), "读取超时，请稍后重试");
  for (const error of ["upstream https://private.example?token=secret", new Error("secret"), { message: "secret" }, undefined]) {
    assert.equal(articleErrorCopy(error), "原文操作失败，请稍后重试");
  }
});
