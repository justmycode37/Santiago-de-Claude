// One-off, second pass on build4.mjs after looking at the first render (2026-11-21 16:45):
// the rows come from the current app (Free food switched on), the ticket is a wide card under the words
// instead of a close-up that cropped the sheet, and the "which side of the road" crop keeps its text clear of the chip.
const fs = require("fs");
const path = require("path");
const f = path.join(__dirname, "build4.mjs");
let s = fs.readFileSync(f, "utf8");
const rep = (a, b) => { if (!s.includes(a)) throw new Error("missing: " + a.slice(0, 70)); s = s.replace(a, b); };
const cutOut = (from, to, b) => { const i = s.indexOf(from), j = s.indexOf(to, i); if (i < 0 || j < 0) throw new Error("anchors: " + from.slice(0, 50)); s = s.slice(0, i) + b + s.slice(j); };

// media
rep(`still("b3", path.join(CAP, "steps4.png"), null, X(450, 1680, 720), 1920, 1080);`, `still("b3", path.join(CAP, "steps4.png"), null, X(281, 1690, 889), 1920, 1080);`);
rep(`still("tk", path.join(CAP, "journey4.png"), null, X(0, 1872, 1170), 1920, 1080);`, `still("tk", path.join(CAP, "journey4.png"), null, [0, 2238, 1170, 294], 1600, 402); // the bar with Start, Ticket and the fare`);
cutOut(`  still("i1", REC(1), 23.5,`, `  // M the event walkthrough`, `  // rows of the current app's settings (shots5.mjs): Toilets, Drinking water, Free food
  still("i1", path.join(CAP, "row-toilets.png"), null, [0, 12, 1074, 180], 1200, 201);
  still("i2", path.join(CAP, "row-water.png"), null, [0, 12, 1074, 180], 1200, 201);
  still("i3", path.join(CAP, "row-food.png"), null, [0, 12, 1074, 180], 1200, 201);
`);

// L rows
cutOut(`    <div id="act5-i0" class="act5-t" style="left: 480px;`, `  [["i1", 15], ["i2", 16], ["i3", 17]].forEach`, `    <div id="act5-i0" class="act5-t" style="left: 360px; top: 196px; font-size: 34px; letter-spacing: 0.12em; text-transform: uppercase; color: \${C.dim}">On your map</div>
    <img id="act5-i1" class="act5-row" style="top: 270px" src="assets/i1.png" alt="" />
    <img id="act5-i2" class="act5-row" style="top: 505px" src="assets/i2.png" alt="" />
    <img id="act5-i3" class="act5-row" style="top: 740px" src="assets/i3.png" alt="" />\`;
`);
rep(`.act5-row { position: absolute; left: 480px; width: 960px; height: 135px; border-radius: 26px;`, `.act5-row { position: absolute; left: 360px; width: 1200px; height: 201px; border-radius: 40px;`);

// N ticket
cutOut(`  // N — the ticket button and the fare under it, close up`, `  // the line that closes the act`, `  // N — the bar with Start and Ticket and the fare under it, as a wide card under the words
  html += \`
    <div id="act5-tkc" class="act5-tkc" data-layout-allow-overflow><img src="assets/tk.png" alt="" /><div id="act5-tap" class="act5-tap"></div><div id="act5-fare" class="act5-fare"></div></div>\`;
  [["Your ticket?", 20, C.ink, 120, 700, 270], ["One tap.", 21, C.accent, 200, 900, 220], ["Price included.", 22, C.orange, 170, 900, 240]].forEach(([txt, i, col, size, w, top], k, all) => {
    html += \`\\n    <div id="act5-t\${k}" class="act5-t" style="left: 0; right: 0; top: \${top}px; text-align: center; font-size: \${size}px; font-weight: \${w}; color: \${col}">\${txt}</div>\`;
    js += \`    up("#act5-t\${k}", \${r3(l(a(i).start) - 0.05)}, 50, 0.34);\\n    hide("#act5-t\${k}", \${r3(l(k + 1 < all.length ? a(all[k + 1][1]).start : t5.end) - 0.08)});\\n\`;
  });
  // immediateRender: false keeps the ring and the outline invisible until their moment
  js += \`    tl.fromTo("#act5-tkc", { opacity: 0, y: 140, scale: 0.96, transformOrigin: "50% 50%" }, { opacity: 1, y: 0, scale: 1, duration: 0.5, ease: "expo.out" }, \${l(t5.N)});
    tl.fromTo("#act5-tap", { opacity: 0.95, scale: 0.35 }, { opacity: 0, scale: 2.2, duration: 0.6, ease: "power2.out", immediateRender: false }, \${r3(l(a(21).start) + 0.12)});
    tl.fromTo("#act5-fare", { opacity: 0, scale: 1.2 }, { opacity: 1, scale: 1, duration: 0.3, ease: "back.out(2)", immediateRender: false }, \${r3(l(a(22).start) + 0.05)});
    hide("#act5-tkc", \${l(t5.end)});\\n\`;
`);
rep(`    .act5-tap { position: absolute; left: \${812 - 80}px; top: \${763 - 80}px; width: 160px; height: 160px; border-radius: 50%; border: 10px solid \${C.navy}; opacity: 0; }`,
    `    .act5-tkc { position: absolute; left: 160px; top: 590px; width: 1600px; height: 402px; border-radius: 44px; background: #fff; box-shadow: 0 30px 90px rgba(0,0,0,0.6); opacity: 0; }
    .act5-tkc img { position: absolute; left: 0; top: 0; width: 1600px; height: 402px; border-radius: 44px; display: block; }
    .act5-tap { position: absolute; left: \${677 - 80}px; top: \${135 - 80}px; width: 160px; height: 160px; border-radius: 50%; border: 10px solid \${C.navy}; opacity: 0; }
    .act5-fare { position: absolute; left: 40px; top: 256px; width: 790px; height: 94px; border-radius: 26px; border: 7px solid \${C.orange}; opacity: 0; }`);
fs.writeFileSync(f, s);
console.log("build4.mjs patched (pass 2)");
