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
const TEXT_MAX_WIDTH = CANVAS_WIDTH - CONTENT_START_X - PADDING; 
const LINE_HEIGHT = 24; 

// --- Types ---
type Atom = 
    | { type: 'text'; content: string; width: number }
    | { type: 'emoji'; url: string; width: number; image?: Image }
    | { type: 'newline' };

interface MessageData {
    username: string;
    avatarUrl: string;
    content: string;
    roleColor?: string;
    timestamp?: string;
}

interface PreparedMessage {
    data: MessageData;
    atoms: Atom[];
    lines: Atom[][];
    height: number;
}

/**
 * Tokenizes the string into atomic parts.
 */
function tokenizeContent(text: string, ctx: any): Atom[] {
    const atoms: Atom[] = [];
    const cleanText = text.replace(/\r/g, '');

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

    let cursor = 0;
    const pushTextAtoms = (substring: string) => {
        const lines = substring.split(/(\n)/g);
        for (const line of lines) {
            if (line === '') continue;
            if (line === '\n') {
                atoms.push({ type: 'newline' });
            } else {
                const words = line.split(/( )/g);
                for (const word of words) {
                    if (word === '') continue;
                    if (word === ' ') {
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

function prepareMessageLayout(data: MessageData, ctx: any): PreparedMessage {
    let messageContent = data.content || " ";
    
    let atoms = tokenizeContent(messageContent, ctx);

    // Clean up spaces around newlines
    for (let i = 0; i < atoms.length; i++) {
        const currentAtom = atoms[i];
        if (!currentAtom || currentAtom.type !== 'newline') continue;

        let prevIndex = i - 1;
        while (prevIndex >= 0) {
            const prevAtom = atoms[prevIndex];
            if (prevAtom && prevAtom.type === 'text' && !prevAtom.content.trim()) {
                prevIndex--;
            } else {
                break;
            }
        }

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

        if (prev && next && prev.type === 'emoji' && next.type === 'emoji') {
            atoms[i] = { type: 'text', content: ' ', width: 4 };
            for (let k = prevIndex + 1; k < nextIndex; k++) {
                if (k !== i) atoms[k] = { type: 'text', content: '', width: 0 };
            }
        }
    }

    const lines: Atom[][] = [];
    let currentLine: Atom[] = [];
    let currentWidth = 0;

    for (const atom of atoms) {
        if (atom.type === 'newline') {
            lines.push(currentLine);
            currentLine = [];
            currentWidth = 0;
            continue;
        }

        const atomWidth = atom.type === 'text' ? atom.width : 24; 

        if (currentWidth + atomWidth > TEXT_MAX_WIDTH && currentLine.length > 0) {
            if (atom.type === 'text' && atom.content === ' ') continue; 
            lines.push(currentLine);
            currentLine = [atom];
            currentWidth = atomWidth;
        } else {
            currentLine.push(atom);
            currentWidth += atomWidth;
        }
    }
    if (currentLine.length > 0) lines.push(currentLine);

    // --- HEIGHT CALCULATION UPDATE ---
    const contentHeight = lines.length * LINE_HEIGHT;
    
    // We remove the trailing padding to tighten the stack.
    // PADDING (top) + 21 (gap to text start) + contentHeight
    const textBlockHeight = PADDING + 21 + contentHeight;
    const avatarBlockHeight = PADDING + AVATAR_SIZE;

    const blockHeight = Math.max(avatarBlockHeight, textBlockHeight);

    return { data, atoms, lines, height: blockHeight };
}

async function drawMessage(
    ctx: any, 
    prepared: PreparedMessage, 
    yOffset: number
) {
    const { data, lines } = prepared;
    
    try {
        const cleanAvatarUrl = data.avatarUrl.replace(/\.(webp|gif)$/i, '.png');
        const avatarImage = await loadImage(cleanAvatarUrl);
        ctx.save();
        ctx.beginPath();
        ctx.arc(PADDING + (AVATAR_SIZE / 2), yOffset + PADDING + (AVATAR_SIZE / 2), AVATAR_SIZE / 2, 0, Math.PI * 2, true);
        ctx.closePath();
        ctx.clip();
        ctx.drawImage(avatarImage, PADDING, yOffset + PADDING, AVATAR_SIZE, AVATAR_SIZE);
        ctx.restore();
    } catch (e) {
        ctx.fillStyle = '#5865f2';
        ctx.beginPath();
        ctx.arc(PADDING + (AVATAR_SIZE / 2), yOffset + PADDING + (AVATAR_SIZE / 2), AVATAR_SIZE / 2, 0, Math.PI * 2, true);
        ctx.fill();
    }

    ctx.font = BOLD_FONT;
    ctx.fillStyle = data.roleColor || COLORS.TEXT_NAME_DEFAULT;
    ctx.fillText(data.username, CONTENT_START_X, yOffset + PADDING + 16);

    const usernameWidth = ctx.measureText(data.username).width;
    ctx.font = TIMESTAMP_FONT;
    ctx.fillStyle = COLORS.TEXT_MUTED;
    ctx.fillText(data.timestamp || "Today at 4:20 PM", CONTENT_START_X + usernameWidth + 8, yOffset + PADDING + 16);

    ctx.font = REGULAR_FONT;
    ctx.fillStyle = COLORS.TEXT_NORMAL;

    let currentY = yOffset + PADDING + 21;
    
    for (const line of lines) {
        let currentX = CONTENT_START_X;
        for (const atom of line) {
            if (atom.type === 'text') {
                ctx.fillText(atom.content, currentX, currentY + 16); 
                currentX += atom.width;
            } else if (atom.type === 'emoji' && atom.image) {
                ctx.drawImage(atom.image, currentX, currentY - 2, 22, 22);
                currentX += 24;
            }
        }
        currentY += LINE_HEIGHT;
    }
}

export async function generateDiscordMessageImage(
    username: string, 
    avatarUrl: string, 
    messageContent: string,
    roleColor: string = COLORS.TEXT_NAME_DEFAULT,
    requesterData?: { 
        username: string; 
        avatarUrl: string; 
        content: string; 
        roleColor?: string; 
    }
): Promise<Buffer> {
    
    const tempCanvas = createCanvas(CANVAS_WIDTH, 100);
    const ctx = tempCanvas.getContext('2d');
    ctx.font = REGULAR_FONT;

    const messagesToRender: PreparedMessage[] = [];

    if (requesterData) {
        messagesToRender.push(prepareMessageLayout({
            username: requesterData.username,
            avatarUrl: requesterData.avatarUrl,
            content: requesterData.content,
            roleColor: requesterData.roleColor || COLORS.TEXT_NAME_DEFAULT,
            timestamp: "Today at 4:19 PM"
        }, ctx));
    }

    messagesToRender.push(prepareMessageLayout({
        username,
        avatarUrl,
        content: messageContent,
        roleColor,
        timestamp: "Today at 4:20 PM"
    }, ctx));

    const allAtoms = messagesToRender.flatMap(m => m.atoms);
    await Promise.all(allAtoms.map(async (atom) => {
        if (atom.type === 'emoji') {
            try { atom.image = await loadImage(atom.url); } catch(e) {}
        }
    }));

    // Add padding to height
    const totalHeight = messagesToRender.reduce((sum, msg) => sum + msg.height, 0) + PADDING;

    const canvas = createCanvas(CANVAS_WIDTH, totalHeight);
    const finalCtx = canvas.getContext('2d');

    // 1. Draw Background
    finalCtx.fillStyle = COLORS.BACKGROUND;
    finalCtx.fillRect(0, 0, CANVAS_WIDTH, totalHeight);

    // 2. Draw Messages
    let currentYOffset = 0;
    for (const msg of messagesToRender) {
        await drawMessage(finalCtx, msg, currentYOffset);
        currentYOffset += msg.height;
    }

    // 3. [NEW] Draw Rounded Border
    // Discord images have rounded corners (~8px). 
    // We inset the border and round it so it looks like a native "card" and doesn't get cut.
    
    finalCtx.strokeStyle = '#202225'; 
    finalCtx.lineWidth = 4; 
    
    // Inset by 2px (half of 4px) so the stroke is fully inside the canvas (0 to 4px)
    const x = 2;
    const y = 2;
    const w = CANVAS_WIDTH - 4;
    const h = totalHeight - 4;
    const radius = 8; // Matches Discord's typical image border radius

    finalCtx.beginPath();
    
    // Check if roundRect is supported (modern canvas), otherwise use fallback
    // @ts-ignore - roundRect might not be in the type definition yet
    if (finalCtx.roundRect) {
        // @ts-ignore
        finalCtx.roundRect(x, y, w, h, radius);
    } else {
        // Manual rounded rect drawing
        finalCtx.moveTo(x + radius, y);
        finalCtx.lineTo(x + w - radius, y);
        finalCtx.quadraticCurveTo(x + w, y, x + w, y + radius);
        finalCtx.lineTo(x + w, y + h - radius);
        finalCtx.quadraticCurveTo(x + w, y + h, x + w - radius, y + h);
        finalCtx.lineTo(x + radius, y + h);
        finalCtx.quadraticCurveTo(x, y + h, x, y + h - radius);
        finalCtx.lineTo(x, y + radius);
        finalCtx.quadraticCurveTo(x, y, x + radius, y);
    }
    
    finalCtx.stroke();

    return canvas.toBuffer('image/png');
}