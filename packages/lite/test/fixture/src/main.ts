import { load, first, apply, untyped, dated, firstWord, LIMIT, MARKER, double } from "./lib.js";
const lessons = await load(["a", "b"]);
first(lessons);
apply([{ op: "append", text: "x" }, { op: "file", path: "p", content: null }]);
untyped({ value: 3 });
dated(new Date(0), new Map([["k", 1]]));
firstWord("hello");
console.log(lessons.length, LIMIT, MARKER.length, double(2));
