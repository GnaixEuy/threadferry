import assert from "node:assert/strict";
import test from "node:test";
import { decideAction } from "../src/action-policy.js";

test("action policy keeps private data out of groups and destructive changes behind confirmation", () => {
  assert.equal(decideAction({ mode: "read", private: false, channel: "group", owner: true, explicit: true }), "deny_private");
  assert.equal(decideAction({ mode: "write", private: true, channel: "group", owner: true, explicit: true }), "deny_private");
  assert.equal(decideAction({ mode: "read", private: true, channel: "direct", owner: true, explicit: true }), "execute");
  assert.equal(decideAction({ mode: "write", private: false, channel: "direct", owner: true, explicit: true }), "execute");
  assert.equal(decideAction({ mode: "write", private: false, channel: "group", owner: false, explicit: true }), "confirm");
  assert.equal(decideAction({ mode: "destructive", private: false, channel: "direct", owner: true, explicit: true }), "confirm");
});
