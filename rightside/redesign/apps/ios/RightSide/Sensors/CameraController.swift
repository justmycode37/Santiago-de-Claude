import Foundation
import Combine
import UIKit
import SwiftUI
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers
import AVFoundation
import Vision
import ImageIO

enum SensorImageError: LocalizedError {
    case oversized, unreadable
    var errorDescription: String? {
        switch self {
        case .oversized: return "Choose an image smaller than 20 MB and 60 megapixels."
        case .unreadable: return "This image could not be read. Choose a JPEG, HEIC or PNG photo."
        }
    }
}

/// File transfer avoids loading an unbounded original image into a Data representation first.
struct ImportedSensorPhoto: Transferable {
    let data: Data
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .image) { received in
            let values = try received.file.resourceValues(forKeys: [.fileSizeKey])
            guard let size = values.fileSize, size > 0, size <= 20 * 1024 * 1024 else {
                throw SensorImageError.oversized
            }
            return ImportedSensorPhoto(data: try Data(contentsOf: received.file))
        }
    }
}

enum SensorImagePreparation {
    static let maximumDimension = 2048

    /// ImageIO applies EXIF orientation before returning the bounded upright raster.
    static func imported(_ data: Data) throws -> CGImage {
        guard data.count <= 20 * 1024 * 1024 else { throw SensorImageError.oversized }
        guard let source = CGImageSourceCreateWithData(data as CFData, [kCGImageSourceShouldCache: false] as CFDictionary),
              let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? NSNumber,
              let height = properties[kCGImagePropertyPixelHeight] as? NSNumber,
              width.doubleValue > 0, height.doubleValue > 0 else { throw SensorImageError.unreadable }
        guard width.doubleValue * height.doubleValue <= 60_000_000 else { throw SensorImageError.oversized }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maximumDimension,
            kCGImageSourceShouldCacheImmediately: true
        ]
        guard let raster = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw SensorImageError.unreadable
        }
        return raster
    }

    @MainActor static func camera(_ image: UIImage) throws -> CGImage {
        guard let source = image.cgImage else { throw SensorImageError.unreadable }
        let swapsAxes: Bool
        switch image.imageOrientation {
        case .left, .leftMirrored, .right, .rightMirrored: swapsAxes = true
        default: swapsAxes = false
        }
        let orientedSize = CGSize(width: CGFloat(swapsAxes ? source.height : source.width),
                                  height: CGFloat(swapsAxes ? source.width : source.height))
        let ratio = min(1, CGFloat(maximumDimension) / max(orientedSize.width, orientedSize.height))
        let size = CGSize(width: max(1, (orientedSize.width * ratio).rounded()),
                          height: max(1, (orientedSize.height * ratio).rounded()))
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.opaque = true
        let normalized = UIGraphicsImageRenderer(size: size, format: format).image { context in
            UIColor.black.setFill()
            context.fill(CGRect(origin: .zero, size: size))
            image.draw(in: CGRect(origin: .zero, size: size))
        }
        guard let raster = normalized.cgImage else { throw SensorImageError.unreadable }
        return raster
    }
}

struct SensorOCRLine: Identifiable {
    let id = UUID()
    let text: String
    let confidence: Float
    let sourceBox: CGRect
}

enum SensorImageSelection: String, CaseIterable, Identifiable {
    case wholeImage = "Whole image"
    case centerCrop = "Center crop"
    var id: String { rawValue }
    var normalizedRect: CGRect {
        self == .wholeImage ? CGRect(x: 0, y: 0, width: 1, height: 1)
            : CGRect(x: 0.15, y: 0.25, width: 0.7, height: 0.5)
    }
}

@MainActor
final class CameraController: ObservableObject {
    @Published private(set) var image: UIImage?
    @Published private(set) var lines: [SensorOCRLine] = []
    @Published private(set) var status = "Take or import a photo, then choose Read text."
    @Published private(set) var provenance = "No image selected"
    @Published private(set) var busy = false
    @Published var showsCamera = false
    @Published private(set) var cameraDenied = false
    @Published private(set) var selection: SensorImageSelection = .wholeImage
    private var epoch = SensorResultEpoch()
    private var photoTask: Task<Void, Never>?
        private let workQueue = DispatchQueue(label: "RightSide.sensor.image-work", qos: .userInitiated)
    private var active = true

    var imageSize: CGSize {
        guard let raster = image?.cgImage else { return .zero }
        return CGSize(width: CGFloat(raster.width), height: CGFloat(raster.height))
    }
    var crop: CGRect { SensorGeometry.pixelCrop(normalized: selection.normalizedRect, image: imageSize) }

    func resume() { active = true }

    private func invalidate() {
        epoch.invalidate()
        photoTask?.cancel(); photoTask = nil
        lines = []
        busy = false
    }

    func clear() {
        invalidate()
        image = nil
        provenance = "No image selected"
        status = "Take or import a photo, then choose Read text."
    }

    func targetChanged() {
        invalidate()
        showsCamera = false
        status = image == nil ? "Target changed. Select an image." : "Target changed. Read the selected image again."
    }

    func select(_ value: SensorImageSelection) {
        guard selection != value else { return }
        invalidate()
        selection = value
        status = "Selection changed. Read text to analyze this region."
    }

    /// Dismissing the system picker releases its camera; no second AVCaptureSession exists.
    func suspend() {
        active = false
        showsCamera = false
        invalidate()
        status = image == nil ? "Camera stopped." : "Camera stopped. Read text again to analyze the retained image."
    }

    func openCamera() {
        guard active, !showsCamera else { return }
        guard UIImagePickerController.isSourceTypeAvailable(.camera) else {
            status = "A camera is unavailable on this device. Import a photo instead."; return
        }
        guard let description = Bundle.main.object(forInfoDictionaryKey: "NSCameraUsageDescription") as? String,
              !description.isEmpty else {
            status = "Camera unavailable: the app is missing its camera privacy description."; return
        }
        clear()
        cameraDenied = false
        let token = epoch.token
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized: showsCamera = true
        case .notDetermined:
            status = "Choose whether to allow the camera."
            AVCaptureDevice.requestAccess(for: .video) { [weak self] allowed in
                Task { @MainActor [weak self] in
                    guard let self, self.active, self.epoch.accepts(token) else { return }
                    self.cameraDenied = !allowed
                    self.showsCamera = allowed
                    self.status = allowed ? "Take a still photo." : "Camera access denied. Import a photo or enable access in Settings."
                }
            }
        case .denied, .restricted:
            cameraDenied = true
            status = "Camera access is denied or restricted. Import a photo or check Settings."
        @unknown default: status = "Camera authorization is unavailable."
        }
    }

    func acceptCameraImage(_ captured: UIImage) {
        guard active, showsCamera else { return }
        showsCamera = false
        clear()
        do {
            image = UIImage(cgImage: try SensorImagePreparation.camera(captured))
            provenance = "Camera still · received \(Date().formatted(date: .omitted, time: .standard)) · single frame, not tracked"
            status = "Photo ready. Choose a region and read text."
        } catch { status = error.localizedDescription }
    }

    func importPhoto(_ item: PhotosPickerItem?) {
        guard let item else { return }
        showsCamera = false
        clear()
        busy = true
        status = "Loading the selected photo…"
        let token = epoch.token
        photoTask = Task { [weak self] in
            do {
                guard let transfer = try await item.loadTransferable(type: ImportedSensorPhoto.self) else {
                    throw SensorImageError.unreadable
                }
                guard !Task.isCancelled, let self, self.active, self.epoch.accepts(token) else { return }
                self.workQueue.async { [weak self] in
                    let result = Result { try SensorImagePreparation.imported(transfer.data) }
                    Task { @MainActor [weak self] in
                        guard let self, self.active, self.epoch.accepts(token) else { return }
                        self.busy = false
                        switch result {
                        case .success(let raster):
                            self.image = UIImage(cgImage: raster)
                            self.provenance = "Imported photo · capture time unverified · replay evidence"
                            self.status = "Photo ready. Choose a region and read text."
                        case .failure(let error): self.status = error.localizedDescription
                        }
                    }
                }
            } catch {
                guard !Task.isCancelled, let self, self.active, self.epoch.accepts(token) else { return }
                self.busy = false
                self.status = error.localizedDescription
            }
        }
    }

    func readText() {
        guard active, !busy, let raster = image?.cgImage,
              let selected = raster.cropping(to: crop) else { return }
        invalidate()
        let token = epoch.token
        let selectedCrop = crop
        busy = true
        status = "Reading text locally on this device…"
        workQueue.async { [weak self] in
            // Vision request is owned only by this serial worker; epochs discard obsolete output.
            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            recognition.usesLanguageCorrection = false
            recognition.automaticallyDetectsLanguage = true
            let result: Result<[SensorOCRLine], Error> = Result {
                try VNImageRequestHandler(cgImage: selected, orientation: .up, options: [:]).perform([recognition])
                return (recognition.results ?? []).compactMap { observation in
                    guard let candidate = observation.topCandidates(1).first else { return nil }
                    return SensorOCRLine(text: candidate.string, confidence: candidate.confidence,
                        sourceBox: SensorGeometry.visionBox(observation.boundingBox, crop: selectedCrop))
                }
            }
            Task { @MainActor [weak self] in
                guard let self, self.active, self.epoch.accepts(token) else { return }
                self.busy = false
                switch result {
                case .success(let lines):
                    self.lines = lines
                    self.status = lines.isEmpty ? "No readable text found. Try a clearer image or another crop."
                        : "Raw text read. Service remains unconfirmed."
                case .failure(let error): self.status = "Text recognition failed: \(error.localizedDescription)"
                }
            }
        }
    }

    func openSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }
}
