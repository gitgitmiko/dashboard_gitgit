import { createContext, useContext } from "react";

export type Session = { home: string; logout: () => void };
export const SessionContext = createContext<Session>({ home: "/", logout: () => {} });
export const useSession = () => useContext(SessionContext);
