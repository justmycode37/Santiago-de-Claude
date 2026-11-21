import SwiftUI
import PhotosUI
import UIKit

@MainActor
struct CameraAssistanceView: View {
    let line: String?
    let destination: String?
    @StateObject private var controller = CameraController()
    @State private var selectedPhoto: PhotosPickerItem?
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                Text("Camera assistance").font(.title2.bold())
                Text("Looking for \(line ?? "an unspecified line") toward \(destination ?? "an unspecified destination")")
                Label(CameraEvidencePolicy.serviceStatus, systemImage: "questionmark.circle.fill")
                    .font(.headline).foregroundStyle(.orange)
                Text(CameraEvidencePolicy.explanation).font(.callout)
                HStack {
                    Button("Take photo", systemImage: "camera") { selectedPhoto = nil; controller.openCamera() }
                    PhotosPicker(selection: $selectedPhoto, matching: .images, photoLibrary: .shared()) {
                        Label("Import photo", systemImage: "photo")
                    }
                }.buttonStyle(.bordered)
                if controller.cameraDenied {
                    Button("Camera settings") { controller.openSettings() }
                }
                Text(controller.status).accessibilityAddTraits(.updatesFrequently)
                if controller.busy { ProgressView() }
                if let image = controller.image {
                    imagePreview(image)
                    Text(controller.provenance).font(.caption).foregroundStyle(.secondary)
                    Picker("Image region", selection: Binding(get: { controller.selection }, set: { controller.select($0) })) {
                        ForEach(SensorImageSelection.allCases) { selection in
                            Text(selection.rawValue).tag(selection)
                        }
                    }.pickerStyle(.segmented)
                    Text("Orange outline: manual text region, not a detected vehicle or segmentation mask.")
                        .font(.caption)
                    HStack {
                        Button("Read text", systemImage: "text.viewfinder") { controller.readText() }
                            .disabled(controller.busy)
                        Button("Clear image", role: .destructive) { controller.clear(); selectedPhoto = nil }
                    }.buttonStyle(.bordered)
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Raw recognized text").font(.headline)
                        if controller.lines.isEmpty { Text("No current OCR result.").foregroundStyle(.secondary) }
                        ForEach(controller.lines) { result in
                            Text(result.text).textSelection(.enabled)
                        }
                    }
                }
                Text("This photo reader extracts text without live vehicle masks or tracking. Recognized text alone does not confirm your service.")
                    .font(.caption).foregroundStyle(.secondary)
                Text("A still photo does not locate you. Close this reader to use live geographic AR where supported. Imported photos may be historical; text alone does not verify a service or platform.")
                    .font(.caption).foregroundStyle(.secondary)
            }.padding()
        }
        .fullScreenCover(isPresented: $controller.showsCamera) {
            SystemStillCamera(onCapture: { controller.acceptCameraImage($0) }, onCancel: { controller.showsCamera = false })
                .ignoresSafeArea()
        }
        .onChange(of: selectedPhoto) { _, item in if let item { controller.importPhoto(item); selectedPhoto = nil } }
        .onChange(of: line) { _, _ in controller.targetChanged() }
        .onChange(of: destination) { _, _ in controller.targetChanged() }
        .onChange(of: scenePhase) { _, phase in
            if phase == .background { controller.suspend() }
            else if phase == .active { controller.resume() }
        }
        .onAppear { controller.resume() }
        .onDisappear {
            // A full-screen camera covers the presenting view. Keep that single owner alive;
            // removal of the presenting hierarchy dismantles the picker itself.
            if !controller.showsCamera { controller.suspend() }
        }
    }

    private func imagePreview(_ image: UIImage) -> some View {
        GeometryReader { proxy in
            let fitted = SensorGeometry.aspectFit(image: controller.imageSize, container: proxy.size)
            let normalized = controller.selection.normalizedRect
            ZStack(alignment: .topLeading) {
                Color.black
                Image(uiImage: image).resizable().scaledToFit()
                    .frame(width: proxy.size.width, height: proxy.size.height)
                Rectangle().stroke(Color.orange, lineWidth: 2)
                    .frame(width: fitted.width * normalized.width, height: fitted.height * normalized.height)
                    .offset(x: fitted.minX + fitted.width * normalized.minX,
                            y: fitted.minY + fitted.height * normalized.minY)
            }
        }
        .frame(height: 300)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .accessibilityLabel("Selected upright photo. \(controller.selection.rawValue) is the manual OCR region.")
    }
}

/// UIKit owns the only capture session. Still photos only, no microphone or recording.
@MainActor
private struct SystemStillCamera: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator(parent: self) }
    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.mediaTypes = ["public.image"]
        picker.allowsEditing = false
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {
        context.coordinator.parent = self
    }
    static func dismantleUIViewController(_ controller: UIImagePickerController, coordinator: Coordinator) {
        controller.delegate = nil
        // UIKit stops its private capture session as the picker leaves the hierarchy.
    }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        var parent: SystemStillCamera
        private var completed = false
        init(parent: SystemStillCamera) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            guard !completed else { return }
            completed = true
            if let image = info[.originalImage] as? UIImage { parent.onCapture(image) }
            else { parent.onCancel() }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            guard !completed else { return }
            completed = true
            parent.onCancel()
        }
    }
}
