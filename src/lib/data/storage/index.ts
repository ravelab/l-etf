import { IStorage } from "./types";
import { LocalStorage } from "./local";

// Always use LocalStorage - reads CSV files from ./public directory
// Works both locally and on Vercel (static file serving)
const storage: IStorage = new LocalStorage();

export default storage;
export * from "./types";
