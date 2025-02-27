// src/services/ws.ts
import { type Server as HttpServer } from "http"
import { Server, type Socket } from "socket.io"
// import jwt from "jsonwebtoken"
import { type ExtendedError } from "socket.io/dist/namespace"
import { ChatRoom } from "@/models/chatRoom"
import { User } from "@/models/user"

declare module "socket.io" {
  interface Socket {
    userInfo?: {
      userId: string
      name: string
      gender?: string
    }
    rooms: Set<string>
  }
}

// 確認使用者id是否存在
async function getUserById (userId: string) {
  try {
    const user = await User.findById(userId).select("personalInfo").exec()
    return user
  } catch (err) {
    console.error("Error fetching user:", err)
    return null
  }
}

const socketErrorHandler = (error: Error, socket: Socket) => {
  console.error("Socket Error:", error)
  socket.emit("error", { message: error.message })
}

const initializeSocket = (server: HttpServer) => {
  const io = new Server(server, {
    cors: {
      origin: "*"
    }
  })

  io.use((socket: Socket, next: (err?: ExtendedError) => void) => {
    const userId = socket.handshake.headers.userid as string // 假設userId是作為查詢參數傳遞的
    if (!userId) {
      const error: ExtendedError = new Error("缺少userId參數") as ExtendedError
      error.data = { statusCode: 400 }
      next(error)
    } else {
      getUserById(userId)
        .then(user => {
          if (user && user.personalInfo) {
            socket.userInfo = {
              userId: user._id.toString(),
              name: user.personalInfo.username,
              gender: user.personalInfo.gender
            }
            next()
          } else {
            const error: ExtendedError = new Error("使用者不存在") as ExtendedError
            error.data = { statusCode: 404 }
            next(error)
          }
        })
        .catch(err => { // Handle any errors that occur during getUserById or the .then chain
          console.error(err)
          const error: ExtendedError = new Error("伺服器錯誤") as ExtendedError
          error.data = { statusCode: 500 }
          next(error)
        })
    }
  })

  io.on("connection", (socket) => {
    console.log(`${socket.userInfo?.name}已經連線`)
    const numberOfClients = io.engine.clientsCount
    // 向client端通知有新的使用者加入
    socket.broadcast.emit(
      "userConnectNotify",
      `有新的小夥伴加入啦!!!讓我們熱烈歡迎${socket.userInfo?.name} 現在線上有 ${numberOfClients} 人`
    )

    // 斷開連接
    socket.on("disconnect", () => {
      const numberOfClients = io.engine.clientsCount
      io.emit(
        "userConnectNotify",
        `有人偷偷落跑啦~~現在線上有 ${numberOfClients} 人`
      )

      socket.rooms.clear()
    })

    // 加入房間
    socket.on("join", async ({ roomId }) => {
      if (process.env.NODE_ENV !== "production") {
        console.log("join", "roomId")
      }
      try {
        const chatRoom = await ChatRoom.findById(roomId)
        if (!chatRoom) {
          socket.emit("error", "房間不存在")
          return
        }
        // 將用戶加入房間
        await socket.join(roomId)
        socket.emit("chatHistory", { messages: chatRoom.messages })
        if (process.env.NODE_ENV !== "production") {
          console.log("socket.rooms", socket.rooms)
        }
      } catch (error) {
        console.error("Failed to join room:", error)
        // 向客戶端發送一個更通用的錯誤訊息
        socket.emit("error", "加入房間時發生錯誤")
      }
    })

    socket.on("error", (error) => {
      socketErrorHandler(error, socket)
    })

    socket.on("leaveRoom", async (roomId) => {
      try {
        await socket.leave(roomId)
        if (process.env.NODE_ENV !== "production") {
          console.log(`User left room: ${roomId}`)
          console.log(`Current rooms:`, socket.rooms)
        }
      } catch (error) {
        console.error("Error leaving room:", error)
      }
    })

    // 聊天消息
    socket.on("chat", async ({ message, roomId }) => {
      console.log(message, roomId)
      try {
        const userId = socket.userInfo?.userId
        // 檢查使用者ID和房間ID是否存在
        if (!userId) {
          socket.emit("error", "用戶未登入")
          return
        }
        // 驗證房間ID
        const chatRoom = await ChatRoom.findById(roomId)
        if (!chatRoom) {
          socket.emit("error", "房間不存在")
          return
        }
        // 驗證使用者是否在聊天室中
        if (!socket.rooms.has(roomId)) {
          socket.emit("error", "用戶未加入目標聊天室")
          return
        }

        await ChatRoom.findByIdAndUpdate(roomId, {
          $push: { messages: { senderId: userId, message } }
        })
        io.to(roomId).emit("message", { message, sender: userId })
      } catch (error) {
        socketErrorHandler(error as Error, socket)
      }
    })
  })
}

export default initializeSocket
