// thumbface.swift — оценка кадров-кандидатов обложки через Apple Vision (macOS).
// Вход: пути к jpg. Выход: строка JSON на кадр:
// {"file":..,"faces":N,"faceH":..,"faceCy":..,"quality":..,"textLines":M,"textAbovePlate":K}
//   faceH   — высота крупнейшего лица в долях высоты кадра
//   faceCy  — вертикальный центр этого лица (0 = верх кадра)
//   quality — VNDetectFaceCaptureQuality: резкость/свет/ракурс (0..1)
//   textLines — «настоящие» строки текста: бокс h<=0.06, w>=0.05, >=3 символов
//   textAbovePlate — строки, чей верх выше линии 84% высоты (нижняя плашка их не прикроет)
import Foundation
import Vision
import AppKit

let PLATE_TOP = 0.84  // нижние 16% прикроет чёрная плашка заголовка

for path in CommandLine.arguments.dropFirst() {
    guard let img = NSImage(contentsOfFile: path),
          let cg = img.cgImage(forProposedRect: nil, context: nil, hints: nil) else {
        print("{\"file\":\"\(path)\",\"error\":\"load\"}"); continue
    }
    let faceReq = VNDetectFaceRectanglesRequest()
    let qualReq = VNDetectFaceCaptureQualityRequest()
    let textReq = VNRecognizeTextRequest()
    textReq.recognitionLevel = .fast
    textReq.usesLanguageCorrection = false
    try? VNImageRequestHandler(cgImage: cg, options: [:]).perform([faceReq, qualReq, textReq])

    var faceH = 0.0, faceCy = 0.0, quality = 0.0
    let faces = faceReq.results ?? []
    if let big = faces.max(by: { $0.boundingBox.height < $1.boundingBox.height }) {
        faceH = Double(big.boundingBox.height)
        faceCy = 1.0 - Double(big.boundingBox.midY)   // Vision меряет снизу
    }
    if let q = (qualReq.results ?? []).compactMap({ $0.faceCaptureQuality }).max() {
        quality = Double(q)
    }
    var lines = 0, above = 0
    for t in (textReq.results ?? []) {
        let bb = t.boundingBox
        let str = t.topCandidates(1).first?.string ?? ""
        // фильтр ложняков: лицо/текстура даёт огромный бокс и 1-2 символа
        if bb.height > 0.06 || bb.width < 0.05 || str.count < 3 { continue }
        lines += 1
        if 1.0 - Double(bb.maxY) < PLATE_TOP { above += 1 }
    }
    print(String(format: "{\"file\":\"%@\",\"faces\":%d,\"faceH\":%.3f,\"faceCy\":%.3f,\"quality\":%.3f,\"textLines\":%d,\"textAbovePlate\":%d}",
                 (path as NSString).lastPathComponent, faces.count, faceH, faceCy, quality, lines, above))
}
