package com.example.mcapi;

import net.minecraft.client.MinecraftClient;
import org.lwjgl.opengl.GL11;

import javax.imageio.IIOImage;
import javax.imageio.ImageIO;
import javax.imageio.ImageWriteParam;
import javax.imageio.ImageWriter;
import javax.imageio.stream.MemoryCacheImageOutputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.util.Iterator;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

public final class ScreenshotService {
    private static final ScreenshotService INSTANCE = new ScreenshotService();
    private static final long MIN_CAPTURE_INTERVAL_NS = 10_000_000L; // ~100fps
    private static final float JPEG_QUALITY = 0.75f;

    private volatile byte[] latestJpeg = new byte[0];
    private final List<StreamClient> clients = new CopyOnWriteArrayList<>();
    private volatile boolean running;
    private volatile long lastCaptureTime;
    private volatile long captureCount;
    private volatile long errorCount;
    private volatile String lastError;
    private volatile int lastWidth;
    private volatile int lastHeight;

    private ScreenshotService() {
    }

    public static ScreenshotService getInstance() {
        return INSTANCE;
    }

    public synchronized void start() {
        if (running) return;
        running = true;
        System.out.println("[mc-api] Screenshot service started, waiting for HudRenderCallback");
    }

    public void tryCapture() {
        if (!running) return;
        long now = System.nanoTime();
        if (now - lastCaptureTime < MIN_CAPTURE_INTERVAL_NS) return;
        lastCaptureTime = now;
        captureFramebuffer();
    }

    public byte[] getLatestJpeg() {
        return latestJpeg;
    }

    public CaptureStatus getStatus() {
        return new CaptureStatus(running, captureCount, errorCount, lastError, lastWidth, lastHeight, latestJpeg.length);
    }

    public void addClient(StreamClient client) {
        clients.add(client);
    }

    public void removeClient(StreamClient client) {
        clients.remove(client);
    }

    private void captureFramebuffer() {
        try {
            MinecraftClient client = MinecraftClient.getInstance();
            if (client == null || client.getWindow() == null) return;

            int width = client.getWindow().getFramebufferWidth();
            int height = client.getWindow().getFramebufferHeight();
            if (width <= 0 || height <= 0) return;

            lastWidth = width;
            lastHeight = height;

            ByteBuffer pixelBuffer = ByteBuffer.allocateDirect(width * height * 4);
            GL11.glReadPixels(0, 0, width, height, GL11.GL_RGBA, GL11.GL_UNSIGNED_BYTE, pixelBuffer);

            int[] pixels = new int[width * height];
            for (int y = 0; y < height; y++) {
                int srcY = height - 1 - y;
                for (int x = 0; x < width; x++) {
                    int i = (srcY * width + x) * 4;
                    int r = pixelBuffer.get(i) & 0xFF;
                    int g = pixelBuffer.get(i + 1) & 0xFF;
                    int b = pixelBuffer.get(i + 2) & 0xFF;
                    int a = pixelBuffer.get(i + 3) & 0xFF;
                    pixels[y * width + x] = (a << 24) | (r << 16) | (g << 8) | b;
                }
            }

            BufferedImage image = new BufferedImage(width, height, BufferedImage.TYPE_INT_RGB);
            image.setRGB(0, 0, width, height, pixels, 0, width);

            byte[] jpeg = encodeJpeg(image);
            if (jpeg == null) {
                errorCount++;
                if (lastError == null || !lastError.startsWith("JPEG")) {
                    lastError = "JPEG encoding failed";
                }
                return;
            }

            latestJpeg = jpeg;
            captureCount++;

            if (captureCount == 1) {
                System.out.println("[mc-api] First frame captured: " + width + "x" + height + " (" + jpeg.length + " bytes)");
            }

            clients.removeIf(c -> !c.write(jpeg));
        } catch (Exception e) {
            errorCount++;
            lastError = e.getClass().getSimpleName() + ": " + e.getMessage();
            System.err.println("[mc-api] Framebuffer capture error: " + lastError);
        }
    }

    private byte[] encodeJpeg(BufferedImage image) {
        Iterator<ImageWriter> writers = ImageIO.getImageWritersByFormatName("jpg");
        if (!writers.hasNext()) {
            lastError = "No JPEG ImageWriter available";
            return null;
        }
        ImageWriter writer = writers.next();
        ImageWriteParam param = writer.getDefaultWriteParam();
        param.setCompressionMode(ImageWriteParam.MODE_EXPLICIT);
        param.setCompressionQuality(JPEG_QUALITY);
        ByteArrayOutputStream baos = new ByteArrayOutputStream();
        try (MemoryCacheImageOutputStream output = new MemoryCacheImageOutputStream(baos)) {
            writer.setOutput(output);
            writer.write(null, new IIOImage(image, null, null), param);
            writer.dispose();
            return baos.toByteArray();
        } catch (Exception e) {
            writer.dispose();
            lastError = "JPEG: " + e.getClass().getSimpleName() + " - " + e.getMessage();
            return null;
        }
    }

    public interface StreamClient {
        boolean write(byte[] jpeg);
        void close();
    }

    public record CaptureStatus(
            boolean running,
            long captureCount,
            long errorCount,
            String lastError,
            int lastWidth,
            int lastHeight,
            int latestJpegSize
    ) {
    }
}
