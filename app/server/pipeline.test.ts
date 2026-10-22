import assert from "node:assert/strict";
import { test } from "node:test";
import { mentionsToWords } from "./pipeline.js";

test("@mentions become plain words the model can follow", () => {
  assert.equal(
    mentionsToWords("@image1 high-fives @image2 while @video keeps rolling", 2),
    "the first character on the reference sheet high-fives the second character on the reference sheet while the original video keeps rolling",
  );
  assert.equal(mentionsToWords("@image3 is not there", 2), "@image3 is not there");
  assert.equal(mentionsToWords("no mentions", 1), "no mentions");
});
