## 2. OSPF 属于哪一层？

OSPF 通常归类为：

> **网络层协议，也就是 OSI 第 3 层协议**

它和 IP、BGP、RIP 的“路由功能”属于同一个大层次，但不能简单说它和 TCP、HTTP 是同一级别。

可以这样看：

```
应用层       HTTP、DNS、SSH
传输层       TCP、UDP
网络层       IP、OSPF、BGP、RIP
数据链路层   Ethernet、PPP、Wi-Fi
物理层       网线、光纤、无线信号
```

---

## 1. OSPF 是什么？全称是什么？

OSPF 全称是：

> **Open Shortest Path First**
> 开放最短路径优先协议

它是一种**内部网关协议**：

> IGP，Interior Gateway Protocol

用于同一个自治系统（AS）内部的路由器之间交换拓扑信息、计算路由。
