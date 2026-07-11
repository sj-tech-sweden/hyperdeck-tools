import asyncio
import socket
import ipaddress
import psutil
from fastapi import APIRouter

router = APIRouter()

def get_active_interface_network():
    """
    Finds the primary active network interface that routes traffic out,
    and returns its corresponding ipaddress.IPv4Network object.
    Defaults to 192.168.1.0/24 if it can't determine it reliably.
    """
    # 1. Get the local IP by creating a dummy socket connection to an outside target
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        # Doesn't actually connect, just triggers routing table lookup
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
    except Exception:
        local_ip = "127.0.0.1"

    # 2. Look up the matching interface mask via psutil
    interfaces = psutil.net_if_addrs()
    for interface_name, addrs in interfaces.items():
        for addr in addrs:
            if addr.family == socket.AF_INET and addr.address == local_ip:
                # Combine the IP and netmask into a strict CIDR network object
                # e.g., '192.168.1.50' + '255.255.255.240' -> 192.168.1.48/28
                return ipaddress.IPv4Interface(f"{local_ip}/{addr.netmask}").network

    # Safe fallback if detection drops out
    return ipaddress.IPv4Network("192.168.1.0/24")

async def check_hyperdeck_port(ip, port=9993, timeout=0.5):
    """
    Attempts to open a quick TCP handshake on the HyperDeck control port.
    """
    try:
        # Open connection with a tight timeout to keep the scan snappy
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(str(ip), port), 
            timeout=timeout
        )
        writer.close()
        await writer.wait_closed()
        return str(ip)
    except (asyncio.TimeoutError, ConnectionRefusedError, OSError):
        return None

async def scan_network_worker(queue, results, semaphore):
    """
    Worker task that pulls IPs from the queue and checks them.
    """
    async with semaphore:
        while not queue.empty():
            ip = await queue.get()
            found_ip = await check_hyperdeck_port(ip)
            if found_ip:
                results.append(found_ip)
            queue.task_done()

@router.get("/api/discover")
async def discover_hyperdecks():
    # Dynamically resolve the active subnet boundaries
    network = get_active_interface_network()
    
    # Put all valid hosts in the subnet block into an async queue
    # This automatically drops network/broadcast addresses and respects /16, /24, /28 sizing perfectly
    queue = asyncio.Queue()
    for host in network.hosts():
        await queue.put(host)
        
    results = []
    
    # Cap concurrency to avoid socket exhaustion or hammering local switches
    # 100-200 concurrent tasks is safe and scans a /24 in a couple of seconds
    max_concurrent_tasks = 150 
    semaphore = asyncio.Semaphore(max_concurrent_tasks)
    
    # Spin up workers dynamically based on the smaller of the pool configuration or subnet size
    num_workers = min(max_concurrent_tasks, network.num_addresses)
    workers = [
        asyncio.create_task(scan_network_worker(queue, results, semaphore))
        for _ in range(num_workers)
    ]
    
    # Wait for the queue to drain completely
    await queue.join()
    
    # Cancel our background workers once processing clears out
    for worker in workers:
        worker.cancel()
        
    return {
        "subnet_scanned": str(network),
        "found": results
    }