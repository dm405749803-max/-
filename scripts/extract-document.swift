import AppKit
import Foundation
import ImageIO
import PDFKit
import Vision

struct TextObservation: Codable {
    let text: String
    let confidence: Float
    let x: Double
    let y: Double
    let width: Double
    let height: Double
}

struct PageResult: Codable {
    let page: Int
    let text: String
    let observations: [TextObservation]
    let method: String
}

struct ExtractionResult: Codable {
    let status: String
    let mode: String
    let pages: [PageResult]
    let warning: String?
}

func emit(_ result: ExtractionResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.withoutEscapingSlashes]
    guard let data = try? encoder.encode(result) else {
        FileHandle.standardOutput.write(Data("{\"status\":\"error\",\"mode\":\"unknown\",\"pages\":[],\"warning\":\"结果编码失败\"}".utf8))
        return
    }
    FileHandle.standardOutput.write(data)
}

func recognize(_ image: CGImage, page: Int) throws -> PageResult {
    let request = VNRecognizeTextRequest()
    request.recognitionLevel = .accurate
    request.recognitionLanguages = ["zh-Hans", "en-US"]
    request.usesLanguageCorrection = true
    request.minimumTextHeight = 0.008

    let handler = VNImageRequestHandler(cgImage: image, options: [:])
    try handler.perform([request])
    let results = (request.results ?? []).compactMap { observation -> TextObservation? in
        guard let candidate = observation.topCandidates(1).first else { return nil }
        let box = observation.boundingBox
        return TextObservation(
            text: candidate.string.trimmingCharacters(in: .whitespacesAndNewlines),
            confidence: candidate.confidence,
            x: box.origin.x,
            y: box.origin.y,
            width: box.size.width,
            height: box.size.height
        )
    }.filter { !$0.text.isEmpty }.sorted {
        if abs($0.y - $1.y) > 0.012 { return $0.y > $1.y }
        return $0.x < $1.x
    }
    return PageResult(page: page, text: results.map(\.text).joined(separator: "\n"), observations: results, method: "vision-ocr")
}

func pageImage(_ page: PDFPage) -> CGImage? {
    let bounds = page.bounds(for: .mediaBox)
    guard bounds.width > 0, bounds.height > 0 else { return nil }
    let targetWidth = min(2200.0, max(1400.0, bounds.width * 2.4))
    let targetSize = NSSize(width: targetWidth, height: targetWidth * bounds.height / bounds.width)
    let image = page.thumbnail(of: targetSize, for: .mediaBox)
    var rect = NSRect(origin: .zero, size: image.size)
    return image.cgImage(forProposedRect: &rect, context: nil, hints: nil)
}

func extractPDF(_ url: URL) throws -> ExtractionResult {
    guard let document = PDFDocument(url: url), document.pageCount > 0 else {
        throw NSError(domain: "DocumentExtraction", code: 2, userInfo: [NSLocalizedDescriptionKey: "无法打开 PDF"])
    }
    let maximumPages = min(document.pageCount, 30)
    var pages: [PageResult] = []
    var usedOCR = false
    for index in 0..<maximumPages {
        guard let page = document.page(at: index) else { continue }
        let embedded = (page.string ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if embedded.count >= 20 {
            let lines = embedded.split(whereSeparator: \Character.isNewline).map(String.init).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
            let observations = lines.map { TextObservation(text: $0, confidence: 1, x: 0, y: 0, width: 0, height: 0) }
            pages.append(PageResult(page: index + 1, text: embedded, observations: observations, method: "pdf-text"))
        } else if let image = pageImage(page) {
            usedOCR = true
            pages.append(try recognize(image, page: index + 1))
        }
    }
    let warning = document.pageCount > maximumPages ? "文件超过 30 页，本次只读取前 30 页。" : nil
    return ExtractionResult(status: "ok", mode: usedOCR ? "pdf-text+vision-ocr" : "pdf-text", pages: pages, warning: warning)
}

func extractImage(_ url: URL) throws -> ExtractionResult {
    guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
          let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else {
        throw NSError(domain: "DocumentExtraction", code: 3, userInfo: [NSLocalizedDescriptionKey: "无法打开图片"])
    }
    return ExtractionResult(status: "ok", mode: "vision-ocr", pages: [try recognize(image, page: 1)], warning: nil)
}

guard CommandLine.arguments.count == 2 else {
    emit(ExtractionResult(status: "error", mode: "unknown", pages: [], warning: "缺少文件路径"))
    exit(2)
}

let url = URL(fileURLWithPath: CommandLine.arguments[1])
do {
    let result = url.pathExtension.lowercased() == "pdf" ? try extractPDF(url) : try extractImage(url)
    emit(result)
} catch {
    emit(ExtractionResult(status: "error", mode: "unknown", pages: [], warning: error.localizedDescription))
    exit(1)
}
