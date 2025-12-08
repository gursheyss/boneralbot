import { createCanvas, loadImage, GlobalFonts, Image } from '@napi-rs/canvas';
import { parse as parseTwemoji } from 'twemoji-parser';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Font Registration ---
const fontsDir = path.join(__dirname, '..', 'fonts');

try {
    GlobalFonts.registerFromPath(path.join(fontsDir, 'ggsans-Normal.ttf'), 'gg sans normal');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'ggsans-Medium.ttf'), 'gg sans medium');
    GlobalFonts.registerFromPath(path.join(fontsDir, 'NotoColorEmoji.ttf'), 'Noto Color Emoji');
} catch (e) {
    console.warn(`Font loading failed at: ${fontsDir}`);
}

const REGULAR_FONT = '16px "gg sans normal", "Noto Color Emoji", Arial';
const BOLD_FONT = '16px "gg sans medium", "Noto Color Emoji", Arial';
const TIMESTAMP_FONT = '12px "gg sans normal", "Noto Color Emoji", Arial';

const COLORS = {
    BACKGROUND: '#313338',
    TEXT_NORMAL: '#dbdee1',
    TEXT_MUTED: '#949ba4',
    TEXT_NAME_DEFAULT: '#f2f3f5'
};

const CANVAS_WIDTH = 700;
const PADDING = 16;
const AVATAR_SIZE = 40;
const CONTENT_START_X = PADDING + AVATAR_SIZE + PADDING; 
const TEXT_MAX_WIDTH = CANVAS_WIDTH - CONTENT_START_X - PADDING; // ~612px
const LINE_HEIGHT = 24; 

// --- Types ---
type Atom = 
    | { type: 'text'; content: string; width: number }
    | { type: 'emoji'; url: string; width: number; image?: Image }
    | { type: 'newline' };

/**
 * Tokenizes the string into atomic parts.
 * Now strictly handles newlines vs spaces.
 */
function tokenizeContent(text: string, ctx: any): Atom[] {
    const atoms: Atom[] = [];
    
    // Clean input: remove CR, keep LF
    const cleanText = text.replace(/\r/g, '');

    // 1. Identify Emojis (Custom & Twemoji)
    const customEmojiRegex = /<(a)?:(\w+):(\d+)>/g;
    const customEntities = [];
    let match;
    while ((match = customEmojiRegex.exec(cleanText)) !== null) {
        customEntities.push({
            index: match.index,
            length: match[0].length,
            url: `https://cdn.discordapp.com/emojis/${match[3]}.${match[1] ? 'gif' : 'png'}`
        });
    }

    const twemojiEntities = parseTwemoji(cleanText).map(e => ({
        index: e.indices[0],
        length: e.indices[1] - e.indices[0],
        url: e.url
    }));

    const allEmojis = [...customEntities, ...twemojiEntities].sort((a, b) => a.index - b.index);

    // Scan string
    let cursor = 0;

    const pushTextAtoms = (substring: string) => {
        // Split by newline, preserving it
        const lines = substring.split(/(\n)/g);
        for (const line of lines) {
            if (line === '') continue;
            
            if (line === '\n') {
                atoms.push({ type: 'newline' });
            } else {
                // Split words by space, preserving spaces
                const words = line.split(/( )/g);
                for (const word of words) {
                    if (word === '') continue;
                    if (word === ' ') {
                        // Explicit space atom
                        const w = ctx.measureText(' ').width || 4;
                        atoms.push({ type: 'text', content: ' ', width: w });
                    } else {
                        const w = ctx.measureText(word).width;
                        atoms.push({ type: 'text', content: word, width: w });
                    }
                }
            }
        }
    };

    for (const emoji of allEmojis) {
        if (emoji.index > cursor) {
            pushTextAtoms(cleanText.substring(cursor, emoji.index));
        }
        atoms.push({ type: 'emoji', url: emoji.url, width: 24 });
        cursor = emoji.index + emoji.length;
    }

    if (cursor < cleanText.length) {
        pushTextAtoms(cleanText.substring(cursor));
    }

    return atoms;
}

export async function generateDiscordMessageImage(
    username: string, 
    avatarUrl: string, 
    messageContent: string,
    roleColor: string = COLORS.TEXT_NAME_DEFAULT 
): Promise<Buffer> {
    
    if (!messageContent) messageContent = " ";

    const tempCanvas = createCanvas(CANVAS_WIDTH, 100);
    const ctx = tempCanvas.getContext('2d');
    ctx.font = REGULAR_FONT;

    // 1. Tokenize
    let atoms = tokenizeContent(messageContent, ctx);

    // We iterate through all atoms. If we find a Newline, we look at neighbors.
    for (let i = 0; i < atoms.length; i++) {
        const currentAtom = atoms[i];
        if (!currentAtom || currentAtom.type !== 'newline') continue;

        // 1. Scan backwards skipping whitespace
        let prevIndex = i - 1;
        while (prevIndex >= 0) {
            const prevAtom = atoms[prevIndex];
            if (prevAtom && prevAtom.type === 'text' && !prevAtom.content.trim()) {
                prevIndex--;
            } else {
                break;
            }
        }

        // 2. Scan forwards skipping whitespace
        let nextIndex = i + 1;
        while (nextIndex < atoms.length) {
            const nextAtom = atoms[nextIndex];
            if (nextAtom && nextAtom.type === 'text' && !nextAtom.content.trim()) {
                nextIndex++;
            } else {
                break;
            }
        }

        const prev = atoms[prevIndex];
        const next = atoms[nextIndex];

        // 3. Check if sandwiched between Emojis
        if (prev && next && prev.type === 'emoji' && next.type === 'emoji') {
            atoms[i] = { type: 'text', content: ' ', width: 4 };
            for (let k = prevIndex + 1; k < nextIndex; k++) {
                if (k !== i) atoms[k] = { type: 'text', content: '', width: 0 };
            }
        }
    }

    // 2. Load Images
    await Promise.all(atoms.map(async (atom) => {
        if (atom.type === 'emoji') {
            try { atom.image = await loadImage(atom.url); } catch(e) {}
        }
    }));

    // 3. Layout (Line Wrapping)
    const lines: Atom[][] = [];
    let currentLine: Atom[] = [];
    let currentWidth = 0;

    for (const atom of atoms) {
        // Explicit Newline
        if (atom.type === 'newline') {
            lines.push(currentLine);
            currentLine = [];
            currentWidth = 0;
            continue;
        }

        const atomWidth = atom.type === 'text' ? atom.width : 24; 

        if (currentWidth + atomWidth > TEXT_MAX_WIDTH && currentLine.length > 0) {
            // Handle space at end of line (ignore it)
            if (atom.type === 'text' && atom.content === ' ') {
                continue; 
            }
            lines.push(currentLine);
            currentLine = [atom];
            currentWidth = atomWidth;
        } else {
            currentLine.push(atom);
            currentWidth += atomWidth;
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // 4. Render
    // Calculate Height
    const contentHeight = lines.length * LINE_HEIGHT;
    const canvasHeight = Math.max(AVATAR_SIZE + (PADDING * 2), PADDING + 20 + 5 + contentHeight + PADDING);
    
    const canvas = createCanvas(CANVAS_WIDTH, canvasHeight);
    const finalCtx = canvas.getContext('2d');

    // Draw Background
    finalCtx.fillStyle = COLORS.BACKGROUND;
    finalCtx.fillRect(0, 0, CANVAS_WIDTH, canvasHeight);

    // Draw Avatar
    try {
        const cleanAvatarUrl = avatarUrl.replace(/\.(webp|gif)$/i, '.png');
        const avatarImage = await loadImage(cleanAvatarUrl);
        finalCtx.save();
        finalCtx.beginPath();
        finalCtx.arc(PADDING + (AVATAR_SIZE / 2), PADDING + (AVATAR_SIZE / 2), AVATAR_SIZE / 2, 0, Math.PI * 2, true);
        finalCtx.closePath();
        finalCtx.clip();
        finalCtx.drawImage(avatarImage, PADDING, PADDING, AVATAR_SIZE, AVATAR_SIZE);
        finalCtx.restore();
    } catch (e) {
        finalCtx.fillStyle = '#5865f2';
        finalCtx.beginPath();
        finalCtx.arc(PADDING + (AVATAR_SIZE / 2), PADDING + (AVATAR_SIZE / 2), AVATAR_SIZE / 2, 0, Math.PI * 2, true);
        finalCtx.fill();
    }

    // Draw Header
    finalCtx.font = BOLD_FONT;
    finalCtx.fillStyle = roleColor;
    finalCtx.fillText(username, CONTENT_START_X, PADDING + 16);

    const usernameWidth = finalCtx.measureText(username).width;
    finalCtx.font = TIMESTAMP_FONT;
    finalCtx.fillStyle = COLORS.TEXT_MUTED;
    finalCtx.fillText("Today at 4:20 PM", CONTENT_START_X + usernameWidth + 8, PADDING + 16);

    // Draw Content
    finalCtx.font = REGULAR_FONT;
    finalCtx.fillStyle = COLORS.TEXT_NORMAL;

    let currentY = PADDING + 21;
    
    for (const line of lines) {
        let currentX = CONTENT_START_X;
        
        for (const atom of line) {
            if (atom.type === 'text') {
                // Draw text
                finalCtx.fillText(atom.content, currentX, currentY + 16); 
                currentX += atom.width;
            } else if (atom.type === 'emoji' && atom.image) {
                finalCtx.drawImage(atom.image, currentX, currentY - 2, 22, 22);
                currentX += 24;
            }
        }
        currentY += LINE_HEIGHT;
    }

    return canvas.toBuffer('image/png');
}