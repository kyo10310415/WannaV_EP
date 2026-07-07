const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');

const THUMBS_DIR = path.join(__dirname, '../../uploads/thumbs');

// thumbsディレクトリを確実に作成
if (!fs.existsSync(THUMBS_DIR)) {
  fs.mkdirSync(THUMBS_DIR, { recursive: true });
}

/**
 * MP4動画からサムネイル画像を生成する
 * @param {string} videoPath - 動画ファイルの絶対パス
 * @param {string} filename  - 元の動画ファイル名（拡張子なし部分をベースに使用）
 * @returns {Promise<string|null>} サムネイルのWebパス（例: /uploads/thumbs/thumb-xxx.jpg）、失敗時はnull
 */
async function generateThumbnail(videoPath, filename) {
  return new Promise((resolve) => {
    const basename = path.basename(filename, path.extname(filename));
    const thumbFilename = `thumb-${basename}.jpg`;
    const thumbPath = path.join(THUMBS_DIR, thumbFilename);
    const thumbUrl  = `/uploads/thumbs/${thumbFilename}`;

    // 既に生成済みならスキップ
    if (fs.existsSync(thumbPath)) {
      resolve(thumbUrl);
      return;
    }

    // ffmpeg: 動画の3秒目（短い動画は0秒）からサムネイル1枚を抽出
    // -ss 3    : シーク位置（3秒）
    // -frames:v 1 : 1フレームのみ
    // -vf scale=480:-1 : 幅480px・縦はアスペクト比維持
    // -update 1 : 単一ファイル出力用フラグ
    const args = [
      '-ss', '3',
      '-i', videoPath,
      '-frames:v', '1',
      '-vf', 'scale=480:-1',
      '-update', '1',
      '-q:v', '3',
      thumbPath,
      '-y'
    ];

    execFile('ffmpeg', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        // 3秒目が取れない短い動画は0秒で再試行
        const fallbackArgs = [
          '-ss', '0',
          '-i', videoPath,
          '-frames:v', '1',
          '-vf', 'scale=480:-1',
          '-update', '1',
          '-q:v', '3',
          thumbPath,
          '-y'
        ];
        execFile('ffmpeg', fallbackArgs, { timeout: 30000 }, (err2) => {
          if (err2) {
            console.error('[thumbnail] 生成失敗:', err2.message);
            resolve(null);
          } else {
            console.log('[thumbnail] 生成成功(fallback):', thumbUrl);
            resolve(thumbUrl);
          }
        });
      } else {
        console.log('[thumbnail] 生成成功:', thumbUrl);
        resolve(thumbUrl);
      }
    });
  });
}

module.exports = { generateThumbnail };
