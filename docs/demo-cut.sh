#!/usr/bin/env bash
# 世界向け 30〜60秒（無音・字幕なし・言語非依存）v4
#
# v3 → v4（利用者の指摘 2026-08-29・周回4）:
#  「チップの抜き出しが合っていない」「表示するなら medium だけ」「high ではチップは要らない」
#
#  **抜いていた場所が間違っていた。** v2/v3 で拡大していたのは絞り込みの**件数カウンタ**
#  （`high 0 | medium 1 | cannot 0`）で、これは**書庫全体の分類の内訳**を数えるもの。
#  記録が1件しか無い状態で「medium 1」と数えても意味が無い。
#  見せるべきは**カードに付く判定バッジ**（オレンジの `medium`）で、これが**その1件の判定**である。
#  （利用者提供: rapture_20260829083521.png＝バッジ / rapture_20260829083547.png＝カウンタ。
#   カウンタは `high 135 | medium 181 | cannot 37` のような**多数の記録を分類して説明する時**にだけ要る）
#
#  したがって:
#   - チップ行（カウンタ）の挿入は **3本とも削除**
#   - **medium のバッジだけ**を1回、大きく重ねる
#   - **high では出さない**——並べた2枚がほぼ同じであることが証拠なので、札は要らない
#   - cannot も出さない（落とす工程がそのまま「足りていない」の説明になっている）
#
# バッジの位置（1920x1080 の実測）: x 561-635 / y 469-491。余白を足して x 478-663 / y 452-510。
set -e
# 素材の置き場と、途中の断片を置く作業用フォルダ。**環境変数で渡すか、ここを書き換える。**
# 実在のパスを書かないこと——この台本は公開物なので、利用者名や一時フォルダの名前が乗る。
P="${UNBAKE_FOOTAGE:-./footage}"
S="${UNBAKE_WORK:-./out}"
mkdir -p "$S"
OUT="$S/unbake_demo.mp4"

MASK="drawbox=x=0:y=0:w=1920:h=32:color=black@1:t=fill"
# 判定バッジを切り出して大きく重ねる（背景は同じコマを暗く残す＝どこを拡大したかが分かる）
BADGE="[0:v]${MASK},split=2[bg][fg];\
[bg]eq=brightness=-0.34:saturation=0.30,scale=1280:720[bgs];\
[fg]crop=185:58:478:452,scale=800:-1:flags=lanczos,pad=iw+8:ih+8:4:4:0x9aa0a6[fgs];\
[bgs][fgs]overlay=(W-w)/2:(H-h)/2,fps=30"

seg () {  # $1=file $2=start $3=end $4=speed $5=out
  ffmpeg -v error -ss "$2" -to "$3" -i "$P/$1" \
    -vf "${MASK},setpts=PTS/$4,fps=30,scale=1280:720:flags=lanczos" \
    -an -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p "$S/seg_$5.mp4" -y
}
segb () { # 判定バッジを切り出して重ねる
  ffmpeg -v error -ss "$2" -to "$3" -i "$P/$1" -filter_complex "$BADGE" \
    -an -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p "$S/seg_$4.mp4" -y
}

rm -f "$S"/seg_*.mp4

# 1) URL を落とす → 記録ができる → 判定が出る（**札の拡大はしない**）
seg  "2url drop.mkv"  3.0    8.3    1.0   01
# 2) 不足の内訳（ノードパック → 落とすものの一覧）
seg  "4download.mkv"  3.0    16.0   5.0   02
# 3) 取得中 → 完了
seg  "4download.mkv"  264.0  277.4  5.0   03
# 4) ★ただ1つの拡大: カードの medium バッジ
segb "4download.mkv"  277.4  278.6         04
# 5) ★対比の前半: medium のまま実行 → 別の絵（等倍）
seg  "5medium.mkv"    28.5   34.2   1.0   05
# 6) 開き直す（5〜19秒は真っ黒＝アプリを閉じている間なので外す。
#    blackdetect は黙るので、コマの PNG サイズで測った: 黒は 1,128 bytes / 通常は 37〜68KB）
seg  "6再起動.mkv"    2.0    4.8    3.0   06a
seg  "6再起動.mkv"    19.5   46.0   14.0  06b
# 7) 実行を押す（**high の札は出さない**）
seg  "7high.mkv"      1.5    5.5    2.0   07
# 8) ★対比の後半: お手本と並べてほぼ同じ（等倍）
seg  "7high.mkv"      25.5   34.8   1.0   08

# 締めの静止 2.0秒
ffmpeg -v error -sseof -0.1 -i "$S/seg_08.mp4" -frames:v 1 "$S/last.png" -y
ffmpeg -v error -loop 1 -t 2.0 -i "$S/last.png" -vf "fps=30,scale=1280:720" \
  -an -c:v libx264 -crf 20 -preset veryfast -pix_fmt yuv420p "$S/seg_09.mp4" -y

printf "file '%s'\n" "$S/seg_01.mp4" "$S/seg_02.mp4" "$S/seg_03.mp4" "$S/seg_04.mp4" \
                     "$S/seg_05.mp4" "$S/seg_06a.mp4" "$S/seg_06b.mp4" "$S/seg_07.mp4" \
                     "$S/seg_08.mp4" "$S/seg_09.mp4" > "$S/list.txt"

ffmpeg -v error -f concat -safe 0 -i "$S/list.txt" -c copy "$OUT" -y
echo -n "合計: "; ffprobe -v error -of csv=p=0 -show_entries format=duration "$OUT"
