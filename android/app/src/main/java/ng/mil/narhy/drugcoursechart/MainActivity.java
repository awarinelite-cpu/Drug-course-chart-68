package ng.mil.narhy.drugcoursechart;

import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.media.AudioAttributes;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.provider.Settings;
import android.webkit.WebSettings;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

  // Must match the channel_id the Cloud Function sends in the FCM payload
  // (functions/index.js) and the default channel declared in
  // AndroidManifest.xml, so background/killed-app pushes land on this exact
  // channel rather than an auto-created fallback that may be silent.
  private static final String DOSE_ALERT_CHANNEL_ID = "dose-due-alerts";

  @Override
  public void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // The dose-due alarm (js/push.js) plays a Web Audio beep the moment a
    // push notification arrives while the app is open. On a plain web page
    // that's blocked by autoplay policy until the user has tapped the page
    // at least once since load (see js/push.js's shared-AudioContext fix).
    // Wrapping this in Capacitor gives us something a browser tab never
    // has: direct control over the WebView's own settings. Turning this
    // flag off removes the "must have a user gesture first" requirement
    // for this WebView specifically, so AudioContext starts in "running"
    // state right away and the alarm is audible from the very first push,
    // with no dependency on the nurse having tapped anything first.
    WebSettings settings = getBridge().getWebView().getSettings();
    settings.setMediaPlaybackRequiresUserGesture(false);

    createDoseAlertChannel();
  }

  // Covers the OTHER half of the alarm: when the app is backgrounded or
  // fully closed, there's no page/AudioContext running at all, so this has
  // nothing to do with the WebView setting above. That case is handled
  // entirely by the OS posting a system notification for the FCM push (see
  // @capacitor/push-notifications in package.json). Android 8+ requires
  // every notification to belong to a channel, and a channel's importance
  // and sound are fixed at creation time — set once here, before any
  // notification ever needs to use it. IMPORTANCE_HIGH is what makes it
  // heads-up (pop over the lock screen) with sound, rather than silently
  // sitting in the shade like a low-importance channel would.
  private void createDoseAlertChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return; // channels don't exist pre-Oreo

    NotificationChannel channel = new NotificationChannel(
        DOSE_ALERT_CHANNEL_ID,
        "Dose due alerts",
        NotificationManager.IMPORTANCE_HIGH
    );
    channel.setDescription("Alerts when a patient's drug dose is due.");
    channel.enableVibration(true);
    channel.setSound(
        Settings.System.DEFAULT_NOTIFICATION_URI,
        new AudioAttributes.Builder()
            .setUsage(AudioAttributes.USAGE_NOTIFICATION)
            .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
            .build()
    );

    NotificationManager manager = getSystemService(NotificationManager.class);
    manager.createNotificationChannel(channel);
  }
}
