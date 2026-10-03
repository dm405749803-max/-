import AppKit
import Foundation

guard CommandLine.arguments.count == 2 else {
    fputs("Usage: swift make-plan-image.swift OUTPUT.png\n", stderr)
    exit(2)
}

let size = NSSize(width: 1800, height: 900)
let image = NSImage(size: size)
image.lockFocus()
NSColor.white.setFill()
NSRect(origin: .zero, size: size).fill()

let titleAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 42, weight: .semibold),
    .foregroundColor: NSColor.black
]
let rowAttributes: [NSAttributedString.Key: Any] = [
    .font: NSFont.monospacedSystemFont(ofSize: 46, weight: .regular),
    .foregroundColor: NSColor.black
]

NSString(string: "保单年度  当年保费  当年领取  年末现金价值  身故保险金")
    .draw(at: NSPoint(x: 80, y: 760), withAttributes: titleAttributes)

let rows = [
    "1   10000   0      7000    10000",
    "2   10000   0      15000   20000",
    "3   0       3000   21000   23000"
]
for (index, row) in rows.enumerated() {
    NSString(string: row).draw(
        at: NSPoint(x: 120, y: 600 - CGFloat(index * 150)),
        withAttributes: rowAttributes
    )
}
image.unlockFocus()

guard
    let tiff = image.tiffRepresentation,
    let bitmap = NSBitmapImageRep(data: tiff),
    let png = bitmap.representation(using: .png, properties: [:])
else {
    fputs("Unable to render fixture\n", stderr)
    exit(1)
}

try png.write(to: URL(fileURLWithPath: CommandLine.arguments[1]), options: .atomic)
