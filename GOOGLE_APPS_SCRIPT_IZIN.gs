/**
 * GOOGLE_APPS_SCRIPT_IZIN.gs
 * Endpoint JSON untuk PresensiQR.
 *
 * Tujuan:
 * - Membaca respons Google Form izin.
 * - Mengubah setiap respons menjadi object JSON.
 * - Dipanggil oleh PresensiQR melalui URL Web App berakhiran /exec.
 *
 * Form ID default di bawah adalah milik Form yang diberikan ke sistem.
 */

const FORM_ID = '1DzaTq9pjw5rCAEZD_y4vRYbtn8RXNUyrcy3DxxZ08po';

function doGet() {
  try {
    const form = FormApp.openById(FORM_ID);
    const responses = form.getResponses();

    const data = responses.map(function(response) {
      const row = {
        id: response.getId(),
        timestamp: response.getTimestamp().toISOString()
      };

      response.getItemResponses().forEach(function(itemResponse) {
        const title = itemResponse.getItem().getTitle();
        const answer = itemResponse.getResponse();
        row[title] = Array.isArray(answer) ? answer.join(', ') : answer;
      });

      return row;
    });

    return ContentService
      .createTextOutput(JSON.stringify({ success: true, data: data }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({
        success: false,
        message: String(err && err.message ? err.message : err)
      }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
